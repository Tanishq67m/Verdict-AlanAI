/**
 * Provider-agnostic LLM contract. The engine only ever talks to this interface, so swapping
 * Gemini for another provider (or a scripted fake in tests) touches nothing else.
 */

export type LlmPurpose = "plan" | "judge";

export interface LlmRequest {
  /** What the call is for; used in token logs and by the test fake. */
  purpose: LlmPurpose;
  system: string;
  user: string;
  /**
   * Standard JSON Schema for the expected response. Providers translate it to whatever subset
   * they support; callers must still validate the returned text (providers don't guarantee it).
   */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Aborts the call when the run deadline passes. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  /** Includes any "thinking" tokens, which providers bill as output. */
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Thrown for provider/API failures. The engine maps these to result `error`, never `fail`. */
export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Structured log sink: one JSON-serialisable object per event. */
export type LogFn = (event: string, fields: Record<string, unknown>) => void;
