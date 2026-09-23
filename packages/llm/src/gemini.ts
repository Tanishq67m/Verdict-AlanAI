import { ApiError, GoogleGenAI, ThinkingLevel, type GenerateContentConfig } from "@google/genai";
import { toGeminiJsonSchema } from "./jsonSchema.ts";
import { sharedPacer, type MinutePacer } from "./pacer.ts";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type LogFn } from "./types.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  /** Unset = the model's default. Gemini 3 docs recommend thinking_level over thinking_budget. */
  thinkingLevel?: GeminiThinkingLevel;
  /** Max requests per minute sent by this process for this model (default 14; 0 = no limit). */
  requestsPerMinute?: number;
  /** Per-request HTTP timeout in ms (default 60 000). */
  timeoutMs?: number;
  log?: LogFn;
}

const THINKING: Record<GeminiThinkingLevel, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export class GeminiClient implements LlmClient {
  readonly provider = "gemini";
  readonly model: string;
  private readonly ai: GoogleGenAI;
  private readonly thinkingLevel: GeminiThinkingLevel | undefined;
  private readonly log: LogFn;
  /** Set if the API rejects our response schema; later calls fall back to plain JSON mode. */
  private schemaRejected = false;
  private readonly pacer: MinutePacer | null;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey) throw new LlmError("GEMINI_API_KEY is empty", null);
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.thinkingLevel = options.thinkingLevel;
    this.log = options.log ?? (() => {});
    const rpm = options.requestsPerMinute ?? 14;
    this.pacer = rpm > 0 ? sharedPacer(this.model, rpm) : null;
    this.ai = new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: {
        timeout: options.timeoutMs ?? 60_000,
        // The SDK retries 408/429/5xx itself (default 5 attempts, up to 60 s apart). Cap it so a
        // rate-limited provider can't silently eat the whole 5-minute run budget.
        // maxDelay 30 s covers the provider's usual "retry in ~26 s" after a per-minute quota hit.
        retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 30 },
      },
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    try {
      return await this.generate(request, !this.schemaRejected);
    } catch (err) {
      // If this model rejects the JSON Schema (HTTP 400 mentioning the schema), retry once in
      // plain JSON mode. Safe because the engine validates every reply with zod anyway.
      const cause = err instanceof LlmError ? err.cause : undefined;
      const schemaProblem =
        request.jsonSchema !== undefined &&
        !this.schemaRejected &&
        err instanceof LlmError &&
        err.status === 400 &&
        cause instanceof Error &&
        /schema/i.test(cause.message);
      if (!schemaProblem) throw err;
      this.schemaRejected = true;
      this.log("llm_schema_fallback", { provider: this.provider, model: this.model, purpose: request.purpose });
      return this.generate(request, false);
    }
  }

  private async generate(request: LlmRequest, useSchema: boolean): Promise<LlmResponse> {
    // Temperature is deliberately left at the provider default: Gemini 3 docs warn that values
    // below 1.0 can cause looping. Verdict stability comes from deterministic signals (D-2).
    const config: GenerateContentConfig = {
      systemInstruction: request.system,
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.jsonSchema ? { responseMimeType: "application/json" } : {}),
      ...(request.jsonSchema && useSchema ? { responseJsonSchema: toGeminiJsonSchema(request.jsonSchema) } : {}),
      ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: THINKING[this.thinkingLevel] } } : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
    };

    if (this.pacer) {
      const waited = await this.pacer.acquire(request.signal);
      if (waited > 0) this.log("llm_rate_wait", { provider: this.provider, model: this.model, waited_ms: waited });
    }
    const started = Date.now();
    let response;
    try {
      response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        config,
      });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      this.log("llm_error", { provider: this.provider, model: this.model, purpose: request.purpose, status });
      throw new LlmError(
        `Gemini request failed${status ? ` (HTTP ${status})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
        status,
        { cause: err },
      );
    }
    const latencyMs = Date.now() - started;

    const meta = response.usageMetadata;
    const inputTokens = meta?.promptTokenCount ?? 0;
    const outputTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
    const usage = { inputTokens, outputTokens, totalTokens: meta?.totalTokenCount ?? inputTokens + outputTokens };

    // Token log per call (PRD: cost logged per call). Never logs prompt or response text.
    this.log("llm_call", {
      provider: this.provider,
      model: this.model,
      purpose: request.purpose,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      latency_ms: latencyMs,
      finish_reason: response.candidates?.[0]?.finishReason ?? null,
    });

    const text = response.text;
    if (!text) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "no candidates";
      throw new LlmError(`Gemini returned no text (reason: ${reason})`, null);
    }
    return { text, usage, model: this.model, latencyMs };
  }
}
