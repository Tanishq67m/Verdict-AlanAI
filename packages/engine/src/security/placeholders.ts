import type { TaskSpec } from "@verdict/schema";
import type { Secret } from "./redact.ts";

/**
 * The LLM never sees credentials. It types `{{auth.email}}`; the executor swaps in the real
 * value at the last moment, inside the browser session only (PLAN.md C-4).
 */
export function secretsFromSpec(spec: TaskSpec): Secret[] {
  if (!spec.auth) return [];
  return [
    { name: "auth.email", value: spec.auth.email },
    { name: "auth.password", value: spec.auth.password },
  ];
}

export class PlaceholderError extends Error {
  override readonly name = "PlaceholderError";
}

const ANY_PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function resolvePlaceholders(text: string, secrets: readonly Secret[]): string {
  return text.replace(ANY_PLACEHOLDER, (_m, rawName: string) => {
    const secret = secrets.find((s) => s.name === rawName);
    if (!secret) {
      const known = secrets.map((s) => `{{${s.name}}}`).join(", ") || "none";
      throw new PlaceholderError(`Unknown placeholder {{${rawName}}}. Available: ${known}`);
    }
    return secret.value;
  });
}
