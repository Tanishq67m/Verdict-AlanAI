import type { LlmUsage } from "./types.ts";

/**
 * Published paid-tier prices, USD per 1M text tokens (standard, non-batch).
 * Source: https://ai.google.dev/gemini-api/docs/pricing, read 22 Sept 2026.
 * On the free tier real spend is $0; we still report tokens x paid price so the PRD's
 * "cost per run ≤ $0.05" target stays meaningful (PLAN.md §4).
 */
export const PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 }, // promo price through 31 Dec 2026
  "gemini-3.7-flash": { input: 0.75, output: 3.75 }, // promo price through 31 Dec 2026
  "gemini-3.6-flash": { input: 0.75, output: 3.75 }, // promo price through 31 Dec 2026
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
};

export interface Price {
  input: number;
  output: number;
}

/** Price for a model: explicit override first, then the table. Null when unknown. */
export function priceFor(model: string, override?: Price): Price | null {
  if (override) return override;
  return PRICES_USD_PER_MTOK[model] ?? null;
}

export function costUsd(usage: LlmUsage, price: Price): number {
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** Accumulates usage across all LLM calls in a run. */
export class UsageMeter {
  private readonly totals: LlmUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private calls = 0;

  record(usage: LlmUsage): void {
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.totalTokens += usage.totalTokens;
    this.calls++;
  }

  get callCount(): number {
    return this.calls;
  }

  snapshot(): LlmUsage {
    return { ...this.totals };
  }
}
