import type { LlmClient, LlmPurpose, LlmRequest, LlmResponse } from "./types.ts";

/** A scripted reply: fixed text, or a function of the request (e.g. to pick a ref from the snapshot). */
export type FakeReply = string | ((request: LlmRequest) => string);

/**
 * Deterministic LLM for tests. Replies are consumed per purpose, in order; running out throws,
 * which makes "the judge must NOT be called" assertions cheap: script no judge replies.
 */
export class FakeLlmClient implements LlmClient {
  readonly provider = "fake";
  readonly model = "fake-model";
  readonly calls: LlmRequest[] = [];
  private readonly queues: Record<LlmPurpose, FakeReply[]>;

  constructor(script: Partial<Record<LlmPurpose, FakeReply[]>>) {
    this.queues = { plan: [...(script.plan ?? [])], judge: [...(script.judge ?? [])] };
  }

  callsFor(purpose: LlmPurpose): LlmRequest[] {
    return this.calls.filter((c) => c.purpose === purpose);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const next = this.queues[request.purpose].shift();
    if (next === undefined) throw new Error(`FakeLlmClient: no scripted "${request.purpose}" reply left`);
    const text = typeof next === "function" ? next(request) : next;
    return { text, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, model: this.model, latencyMs: 0 };
  }
}
