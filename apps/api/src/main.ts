import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { executeSpec } from "@verdict/worker";
import { buildServer } from "./server.ts";
import { FileRunStore } from "./store.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = process.env;

const apiKey = env["VERDICT_API_KEY"] ?? "";
if (apiKey.length < 16) {
  process.stderr.write("VERDICT_API_KEY must be set (at least 16 characters). Add it to .env.\n");
  process.exit(64);
}
const port = Number(env["PORT"] ?? 8787);
const host = env["HOST"] ?? "127.0.0.1";
const runsDir = resolve(env["VERDICT_RUNS_DIR"] ?? "runs");
const artifactsDir = resolve(env["VERDICT_ARTIFACTS_DIR"] ?? "artifacts");

const store = new FileRunStore(runsDir);
await store.init();

// Secrets are never written to disk, so a run interrupted by a restart can't resume.
for (const r of await store.listUnfinished()) {
  await store.update(r.run_id, { status: "failed", error: "The API restarted before this run finished. Submit a new run.", finished_at: new Date().toISOString() });
}

const { app } = buildServer({
  store,
  apiKey,
  executor: async (spec, o) => {
    const { verdict } = await executeSpec(spec, env, {
      runId: o.runId,
      criterionIds: o.criterionIds,
      commit: o.commit,
      artifactsDir,
      writeLog: (line) => process.stderr.write(`${line}\n`),
    });
    return verdict;
  },
});

await app.listen({ port, host });
process.stderr.write(`Verdict API listening on http://${host}:${port}\n`);
