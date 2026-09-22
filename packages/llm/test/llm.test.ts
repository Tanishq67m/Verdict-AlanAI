import { describe, expect, it } from "vitest";
import { costUsd, createLlmFromEnv, GeminiClient, LlmError, priceFor, toGeminiJsonSchema, UsageMeter } from "../src/index.ts";
import { FakeLlmClient } from "../src/testing.ts";

describe("createLlmFromEnv", () => {
  it("requires GEMINI_API_KEY", () => {
    expect(() => createLlmFromEnv({})).toThrow(/GEMINI_API_KEY is not set/);
  });

  it("builds a Gemini client with the default model and its price", () => {
    const { client, price } = createLlmFromEnv({ GEMINI_API_KEY: "test-key" });
    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.model).toBe("gemini-3.5-flash-lite");
    expect(price).toEqual({ input: 0.3, output: 2.5 });
  });

  it("rejects unknown providers, bad thinking levels and unpriced models", () => {
    expect(() => createLlmFromEnv({ GEMINI_API_KEY: "k", VERDICT_LLM_PROVIDER: "anthropic" })).toThrow(LlmError);
    expect(() => createLlmFromEnv({ GEMINI_API_KEY: "k", GEMINI_THINKING_LEVEL: "max" })).toThrow(/THINKING_LEVEL/);
    expect(() => createLlmFromEnv({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-9-ultra" })).toThrow(/No price known/);
  });

  it("accepts a price override for any model", () => {
    const { price } = createLlmFromEnv({
      GEMINI_API_KEY: "k",
      GEMINI_MODEL: "gemini-9-ultra",
      VERDICT_PRICE_INPUT_PER_MTOK: "1",
      VERDICT_PRICE_OUTPUT_PER_MTOK: "2",
    });
    expect(price).toEqual({ input: 1, output: 2 });
  });
});

describe("cost accounting", () => {
  it("prices input and output tokens separately", () => {
    const price = priceFor("gemini-3.5-flash-lite");
    expect(price).not.toBeNull();
    // 10k in x $0.30/M + 1k out x $2.50/M = $0.003 + $0.0025
    expect(costUsd({ inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 }, price!)).toBeCloseTo(0.0055, 10);
  });

  it("UsageMeter sums calls", () => {
    const m = new UsageMeter();
    m.record({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    m.record({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(m.snapshot()).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
    expect(m.callCount).toBe(2);
  });
});

describe("toGeminiJsonSchema", () => {
  it("turns const into enum, drops unsupported keywords, keeps property names", () => {
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        type: { type: "string", const: "click" },
        ref: { type: "string", pattern: "^e\\d+$", maxLength: 10 },
        pattern: { type: "string" },
      },
      required: ["type", "ref"],
      additionalProperties: false,
    };
    expect(toGeminiJsonSchema(input)).toEqual({
      type: "object",
      properties: {
        type: { type: "string", enum: ["click"] },
        ref: { type: "string" },
        pattern: { type: "string" },
      },
      required: ["type", "ref"],
      additionalProperties: false,
    });
  });
});

describe("FakeLlmClient", () => {
  it("replays scripted replies per purpose and records calls", async () => {
    const fake = new FakeLlmClient({ plan: ["a", (r) => `echo:${r.user}`] });
    expect((await fake.complete({ purpose: "plan", system: "", user: "x" })).text).toBe("a");
    expect((await fake.complete({ purpose: "plan", system: "", user: "y" })).text).toBe("echo:y");
    await expect(fake.complete({ purpose: "judge", system: "", user: "z" })).rejects.toThrow(/no scripted "judge"/);
    expect(fake.callsFor("plan")).toHaveLength(2);
  });
});

describe("GeminiClient schema fallback", () => {
  it("retries once without responseJsonSchema when the API rejects the schema, then stays in JSON mode", async () => {
    const { ApiError } = await import("@google/genai");
    const client = new GeminiClient({ apiKey: "k" });
    const configs: Array<Record<string, unknown>> = [];
    // Replace the SDK call; `ai` is private, so reach it through an index signature for this test only.
    const internal = client as unknown as { ai: { models: { generateContent: (p: { config: Record<string, unknown> }) => Promise<unknown> } } };
    internal.ai.models.generateContent = async (p) => {
      configs.push(p.config);
      if ("responseJsonSchema" in p.config) throw new ApiError({ message: "Invalid JSON payload: responseJsonSchema is not supported", status: 400 });
      return { text: '{"ok":true}', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }, candidates: [] };
    };
    const req = { purpose: "plan" as const, system: "s", user: "u", jsonSchema: { type: "object" } };
    expect((await client.complete(req)).text).toBe('{"ok":true}');
    await client.complete(req);
    expect(configs.map((c) => "responseJsonSchema" in c)).toEqual([true, false, false]);
    expect(configs.every((c) => c["responseMimeType"] === "application/json")).toBe(true);
  });
});
