import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const pnpmCommand = ["pnpm", "--config.engine-strict=false", "--filter", "@premise/runtime-core", "build"].join(" ");
if (process.platform === "win32") await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", pnpmCommand], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
else await run("pnpm", pnpmCommand.split(" ").slice(1), { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
const { stdout, stderr } = await run(process.execPath, ["--test", "tests/premise-security-efficiency.test.mjs"], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(stdout);
process.stderr.write(stderr);
