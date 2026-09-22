import { readFile } from "node:fs/promises";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { TaskSpecV1Schema, type TaskSpec } from "./taskSpec.ts";

export class SpecError extends Error {
  override readonly name = "SpecError";
}

export interface ParseSpecOptions {
  /** Environment used to fill `${VAR}` placeholders. Pass process.env explicitly; nothing is read implicitly. */
  env: Readonly<Record<string, string | undefined>>;
  /** Overrides `base_url` before interpolation (the CLI's `--url`). */
  baseUrl?: string | undefined;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const GITHUB_EXPR = /\$\{\{/;

/**
 * Replaces `${VAR}` inside string values, AFTER YAML parsing. Substituting before parsing
 * would let an env value containing YAML syntax change the document's structure.
 */
function interpolate(value: unknown, env: ParseSpecOptions["env"], path: string, missing: Set<string>): unknown {
  if (typeof value === "string") {
    if (GITHUB_EXPR.test(value)) {
      throw new SpecError(
        `${path}: "\${{ ... }}" is GitHub Actions syntax and is only expanded inside workflow files, ` +
          `never inside .verdict.yml. Use "\${VAR_NAME}" and pass the secret to Verdict as an environment variable.`,
      );
    }
    return value.replace(ENV_REF, (_m, name: string) => {
      const v = env[name];
      if (v === undefined || v === "") {
        missing.add(name);
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${path}[${i}]`, missing));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env, path ? `${path}.${k}` : k, missing);
    return out;
  }
  return value;
}

export function parseSpec(yamlText: string, options: ParseSpecOptions): TaskSpec {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    if (err instanceof YAMLParseError) throw new SpecError(`Invalid YAML: ${err.message}`);
    throw err;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SpecError("Spec must be a YAML mapping (key: value pairs) at the top level.");
  }
  const withOverride = options.baseUrl !== undefined ? { ...raw, base_url: options.baseUrl } : raw;

  const missing = new Set<string>();
  const interpolated = interpolate(withOverride, options.env, "", missing);
  if (missing.size > 0) {
    throw new SpecError(`Missing environment variable(s): ${[...missing].sort().join(", ")}`);
  }

  const result = TaskSpecV1Schema.safeParse(interpolated);
  if (!result.success) {
    throw new SpecError(`Invalid task spec:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadSpecFile(path: string, options: ParseSpecOptions): Promise<TaskSpec> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new SpecError(`Cannot read spec file "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSpec(text, options);
}
