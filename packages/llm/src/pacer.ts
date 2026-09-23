/**
 * Client-side rate limit: at most `rpm` requests in any rolling 60 s window. Gemini's free
 * tier allows 15 requests/minute per model; a 3-criterion run makes ~30 calls in ~2 minutes,
 * so without pacing the provider starts returning 429s mid-run (seen on the first real
 * 3-criterion run). Waiting a few seconds is better than an `error` verdict.
 */
export class MinutePacer {
  private stamps: number[] = [];

  constructor(private readonly rpm: number) {}

  /** Resolves when a request may be sent; returns how long it waited (ms). */
  async acquire(signal?: AbortSignal): Promise<number> {
    let waited = 0;
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.rpm) {
        this.stamps.push(now);
        return waited;
      }
      const oldest = this.stamps[0] ?? now;
      const wait = 60_000 - (now - oldest) + 50;
      await sleep(wait, signal);
      waited += wait;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One pacer per model per process, so consecutive runs (e.g. API jobs) share the budget. */
const pacers = new Map<string, MinutePacer>();
export function sharedPacer(key: string, rpm: number): MinutePacer {
  const id = `${key}@${rpm}`;
  let p = pacers.get(id);
  if (!p) {
    p = new MinutePacer(rpm);
    pacers.set(id, p);
  }
  return p;
}
