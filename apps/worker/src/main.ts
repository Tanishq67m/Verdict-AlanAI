import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createLlmFromEnv, LlmError } from "@verdict/llm";
import { loadSpecFile, SpecError, type Result } from "@verdict/schema";
import { ConfigError, executeSpec } from "./runner.ts";

export const USAGE = `Verdict: check a web app against plain-English acceptance criteria.

Usage:
  pnpm verdict run --spec <file> [options]

Options:
  --spec <file>            Task spec (YAML), e.g. .verdict.example.yml   (required)
  --url <url>              Base URL to test; overrides base_url in the spec
  --criterion <id>         Run only this criterion (repeatable). Default: all
  --commit <sha>           Commit being verified (recorded in the verdict)
  --artifacts-dir <dir>    Where screenshots and traces go (default: artifacts)
  --env-file <file>        Env file to load if present (default: .env)
  --headed                 Show the browser window
  -h, --help               Show this help

Output: the verdict JSON on stdout; structured logs on stderr.
Exit codes: 0 pass, 1 fail, 2 error, 3 inconclusive, 64 usage or configuration error.`;

export const EXIT_CODES: Record<Result, number> = { pass: 0, fail: 1, error: 2, inconclusive: 3 };
export const EXIT_USAGE = 64;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.stdout(`${USAGE}\n`);
    return command === undefined ? EXIT_USAGE : 0;
  }
  if (command !== "run") {
    io.stderr(`Unknown command "${command}".\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: false,
      options: {
        spec: { type: "string" },
        url: { type: "string" },
        criterion: { type: "string", multiple: true },
        commit: { type: "string" },
        "artifacts-dir": { type: "string", default: "artifacts" },
        "env-file": { type: "string", default: ".env" },
        headed: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (!values.spec) {
    io.stderr(`Missing --spec.\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  // Secrets come from the environment only. .env is a local convenience; real env vars win.
  const envFile = values["env-file"];
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile);
  const env = io.env;

  try {
    const spec = await loadSpecFile(values.spec, { env, baseUrl: values.url });
    const { verdict } = await executeSpec(spec, env, {
      criterionIds: values.criterion ?? [],
      commit: values.commit ?? null,
      artifactsDir: values["artifacts-dir"],
      headed: values.headed,
      writeLog: (line) => io.stderr(`${line}\n`),
    });
    io.stdout(`${JSON.stringify(verdict, null, 2)}\n`);
    return EXIT_CODES[verdict.status];
  } catch (err) {
    if (err instanceof SpecError || err instanceof LlmError || err instanceof ConfigError) {
      io.stderr(`${err.message}\n`);
      return EXIT_USAGE;
    }
    if (err instanceof Error && err.message.startsWith("Unknown criterion")) {
      io.stderr(`${err.message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }
}
