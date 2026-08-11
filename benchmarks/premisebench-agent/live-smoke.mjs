import { probeGitHubRead } from "./worlds/github.mjs";
import { probePostgresRead } from "./worlds/postgres.mjs";

const result = {
  benchmark: "PremiseBench-Agent live connector probe",
  mutation: "NOT_RUN",
  github: await probeGitHubRead(),
  postgres: await probePostgresRead()
};

console.log(JSON.stringify(result, null, 2));
