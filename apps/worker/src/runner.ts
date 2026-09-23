import {
  createLogger,
  newRunId,
  Redactor,
  runVerification,
  secretsFromSpec,
  type BeforeAttemptHook,
  type LogLevel,
  type RunResult,
} from "@verdict/engine";
import { createLlmFromEnv } from "@verdict/llm";
import type { TaskSpec } from "@verdict/schema";
import { eventPulseReset } from "./resets/eventpulse.ts";

/** Bad configuration (env vars, unknown reset adapter). Reported as a usage error, never as a verdict. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

/**
 * Test-data reset is configured on the worker (env), never in the spec: a spec comes from a
 * pull request, and a PR must not be able to make the worker call arbitrary endpoints.
 *   VERDICT_RESET=eventpulse
 *   VERDICT_RESET_API_URL=http://localhost:5001/api   (default)
 */
export function resetFromEnv(env: Env, spec: TaskSpec): BeforeAttemptHook | undefined {
  const kind = env["VERDICT_RESET"];
  if (!kind) return undefined;
  if (kind !== "eventpulse") throw new ConfigError(`Unknown VERDICT_RESET "${kind}" (supported: eventpulse)`);
  if (!spec.auth) throw new ConfigError("VERDICT_RESET=eventpulse needs the spec's auth block (the test user's credentials)");
  return eventPulseReset({
    apiUrl: env["VERDICT_RESET_API_URL"] || "http://localhost:5001/api",
    email: spec.auth.email,
    password: spec.auth.password,
  });
}

export interface ExecuteOptions {
  runId?: string;
  criterionIds?: readonly string[];
  commit?: string | null;
  artifactsDir: string;
  headed?: boolean;
  /** Where JSON log lines go (stderr for the CLI). */
  writeLog: (line: string) => void;
}

/** Everything needed to run a spec, wired from environment variables. Shared by the CLI and the API. */
export async function executeSpec(spec: TaskSpec, env: Env, options: ExecuteOptions): Promise<RunResult & { runId: string }> {
  const runId = options.runId ?? newRunId();
  const redactor = new Redactor(secretsFromSpec(spec));
  const requested = env["VERDICT_LOG_LEVEL"] ?? "info";
  const level: LogLevel = LOG_LEVELS.has(requested) ? (requested as LogLevel) : "info";
  const logger = createLogger({ redactor, level, base: { run_id: runId }, write: options.writeLog });
  const { client, price } = createLlmFromEnv(env, (event, fields) => logger.info(event, fields));
  const beforeAttempt = resetFromEnv(env, spec);
  const executablePath = env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

  const result = await runVerification({
    runId,
    spec,
    criterionIds: options.criterionIds ?? [],
    llm: client,
    price,
    redactor,
    logger,
    artifactsDir: options.artifactsDir,
    commit: options.commit ?? null,
    launch: { headless: !options.headed, ...(executablePath ? { executablePath } : {}) },
    ...(beforeAttempt ? { beforeAttempt } : {}),
  });
  logger.info("artifacts_written", { path: result.artifactsPath });
  return { ...result, runId };
}
