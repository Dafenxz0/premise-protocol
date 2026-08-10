import assert from "node:assert/strict";
import { GitHubValidator } from "../dist/index.js";

if (process.env.GITHUB_LIVE !== "1") {
  console.log("validator-github live test skipped; set GITHUB_LIVE=1 to opt in");
} else {
  const token = process.env.GITHUB_TOKEN;
  const sourceUri = process.env.GITHUB_SOURCE_URI;
  assert.ok(token, "GITHUB_TOKEN is required when GITHUB_LIVE=1");
  assert.ok(sourceUri, "GITHUB_SOURCE_URI is required when GITHUB_LIVE=1");
  const adapter = new GitHubValidator({ token, baseUrl: process.env.GITHUB_API_URL });
  const version = await adapter.versionFor(sourceUri);
  console.log(`live GitHub check passed: ${version.scheme}`);
}
