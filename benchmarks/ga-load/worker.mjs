import { parentPort } from "node:worker_threads";

function mix32(value) {
  value >>>= 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

parentPort.on("message", ({ id, start, count, tenantCount, seed }) => {
  try {
    const records = new Array(count);
    for (let offset = 0; offset < count; offset += 1) {
      const index = start + offset;
      records[offset] = [index % tenantCount, index, mix32(seed + index)];
    }
    parentPort.postMessage({ id, records });
  } catch (error) {
    parentPort.postMessage({ id, error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
  }
});
