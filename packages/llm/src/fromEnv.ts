import { DEFAULT_GEMINI_MODEL, GeminiClient, type GeminiThinkingLevel } from "./gemini.ts";
import { LlmError, type LlmClient, type LogFn } from "./types.ts";
import { priceFor, type Price } from "./usage.ts";

const THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high"]);

export interface LlmSetup {
  client: LlmClient;
  price: Price;
}

/**
 * Builds the configured client from environment variables:
 *   VERDICT_LLM_PROVIDER   gemini (default; the only provider in M1)
 *   GEMINI_API_KEY         required
 *   GEMINI_MODEL           default gemini-3.5-flash-lite
 *   GEMINI_THINKING_LEVEL  optional: minimal | low | medium | high
 *   GEMINI_RPM             requests/minute cap (default 14, free tier is 15; 0 = off)
 *   VERDICT_PRICE_INPUT_PER_MTOK / VERDICT_PRICE_OUTPUT_PER_MTOK  override the price table
 */
export function createLlmFromEnv(env: Readonly<Record<string, string | undefined>>, log?: LogFn): LlmSetup {
  const provider = env["VERDICT_LLM_PROVIDER"] ?? "gemini";
  if (provider !== "gemini") {
    throw new LlmError(`Unsupported VERDICT_LLM_PROVIDER "${provider}" (supported: gemini)`, null);
  }
  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) throw new LlmError("GEMINI_API_KEY is not set. Add it to .env (see .env.example).", null);

  const model = env["GEMINI_MODEL"] || DEFAULT_GEMINI_MODEL;
  const thinking = env["GEMINI_THINKING_LEVEL"];
  const rpmRaw = env["GEMINI_RPM"];
  const rpm = rpmRaw === undefined || rpmRaw === "" ? undefined : Number(rpmRaw);
  if (rpm !== undefined && (!Number.isInteger(rpm) || rpm < 0)) {
    throw new LlmError(`GEMINI_RPM must be a whole number >= 0 (got "${rpmRaw}")`, null);
  }
  if (thinking && !THINKING_LEVELS.has(thinking)) {
    throw new LlmError(`GEMINI_THINKING_LEVEL must be one of minimal, low, medium, high (got "${thinking}")`, null);
  }

  const inOverride = env["VERDICT_PRICE_INPUT_PER_MTOK"];
  const outOverride = env["VERDICT_PRICE_OUTPUT_PER_MTOK"];
  const override = inOverride && outOverride ? { input: Number(inOverride), output: Number(outOverride) } : undefined;
  if (override && (!Number.isFinite(override.input) || !Number.isFinite(override.output))) {
    throw new LlmError("VERDICT_PRICE_*_PER_MTOK must be numbers", null);
  }
  const price = priceFor(model, override);
  if (!price) {
    throw new LlmError(
      `No price known for model "${model}". Set VERDICT_PRICE_INPUT_PER_MTOK and VERDICT_PRICE_OUTPUT_PER_MTOK.`,
      null,
    );
  }

  const client = new GeminiClient({
    apiKey,
    model,
    ...(thinking ? { thinkingLevel: thinking as GeminiThinkingLevel } : {}),
    ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}),
    ...(log ? { log } : {}),
  });
  return { client, price };
}
