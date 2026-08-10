export function shouldFlushDurableWrite(pathname, method, storeMode) {
  if (storeMode !== "postgres" || method !== "POST") return false;

  return pathname === "/v2/memories" ||
    pathname === "/v2/source-changed" ||
    /^\/v2\/memories\/[^/]+\/revalidate$/u.test(pathname);
}
