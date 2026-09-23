/**
 * Runs jobs one at a time, in order. One browser run at a time is what a single worker can
 * handle; a real queue (BullMQ) becomes worth it when there are several workers.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get pending(): number {
    return this.waiting;
  }

  push(job: () => Promise<void>): void {
    this.waiting++;
    this.tail = this.tail
      .then(job)
      .catch(() => undefined) // jobs record their own failures; the chain must never break
      .finally(() => {
        this.waiting--;
      });
  }

  /** Resolves when everything queued so far has finished (used by tests and shutdown). */
  onIdle(): Promise<void> {
    return this.tail;
  }
}
