import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "benchmarks/premisebench-agent/artifacts"], { encoding: "utf8" }).trim();
if (tracked) throw new Error(`Generated benchmark artifacts must not be tracked:\n${tracked}`);
console.log("PremiseBench-Agent artifact check: PASS (generated output is outside Git)");
