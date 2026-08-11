const apiRoot = "https://api.github.com";
const safeRepo = /^[^/\s]+\/[^/\s]+$/;

function requireRepo(repo) {
  if (typeof repo !== "string" || !safeRepo.test(repo)) throw new Error("GitHub repo must be owner/name");
  return repo;
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function githubFetch(path, { token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${apiRoot}${path}`, { headers: headers(token) });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`GitHub ${response.status} for ${path}`);
    error.status = response.status;
    error.body = body.slice(0, 500);
    throw error;
  }
  return { data: body.length === 0 ? null : JSON.parse(body), etag: response.headers.get("etag"), rateLimitRemaining: response.headers.get("x-ratelimit-remaining") };
}

export function liveGitHubConfig(env = process.env) {
  const repo = env.PREMISE_GITHUB_REPO;
  if (!repo || !safeRepo.test(repo)) return { status: "NOT_RUN", reason: "PREMISE_GITHUB_REPO is not configured" };
  return { status: "READY", repo, tokenConfigured: Boolean(env.GITHUB_TOKEN || env.PREMISE_GITHUB_TOKEN), ref: env.PREMISE_GITHUB_REF || "HEAD", path: env.PREMISE_GITHUB_PATH || "README.md" };
}

export function createGitHubReadWorld({ repo, ref = "HEAD", path = "README.md", token, fetchImpl } = {}) {
  requireRepo(repo);
  let last = null;
  return {
    async read() {
      const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const response = await githubFetch(`/repos/${encodedRepo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { token, fetchImpl });
      const item = response.data;
      if (!item || Array.isArray(item) || typeof item.content !== "string") throw new Error("GitHub contents response did not contain a file");
      const content = Buffer.from(item.content.replace(/\s/g, ""), "base64").toString("utf8");
      last = { content, version: response.etag || item.sha, observedAt: new Date().toISOString(), rateLimitRemaining: response.rateLimitRemaining };
      return last;
    },
    async mutateExternally() {
      throw new Error("GitHub default world is read-only; inject a controlled mutation driver for a campaign");
    },
    async writeIfVersion() {
      throw new Error("GitHub default world is read-only; action writes belong to a controlled target adapter");
    },
    last: () => last,
    status: "READY",
    mutation: "NOT_IMPLEMENTED_BY_DEFAULT"
  };
}

export async function probeGitHubRead(env = process.env, options = {}) {
  const config = liveGitHubConfig(env);
  if (config.status !== "READY") return config;
  try {
    const world = createGitHubReadWorld({ ...config, token: env.GITHUB_TOKEN || env.PREMISE_GITHUB_TOKEN, ...options });
    const snapshot = await world.read();
    return { status: "PASS_READ_ONLY", repo: config.repo, path: config.path, version: snapshot.version, rateLimitRemaining: snapshot.rateLimitRemaining };
  } catch (error) {
    return { status: "NOT_RUN", reason: error.message, repo: config.repo };
  }
}
