import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Verdict } from "@verdict/schema";

export type RunStatus = "queued" | "running" | "done" | "failed";

/** What the API keeps about a run. Never contains secrets: the spec's auth block stays in memory only. */
export interface RunRecord {
  run_id: string;
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  request: { task: string; base_url: string; criteria: string[]; commit: string | null };
  verdict: Verdict | null;
  /** Set when Verdict couldn't produce a verdict at all (bad config, crash). */
  error: string | null;
}

export interface IdempotencyEntry {
  run_id: string;
  body_hash: string;
}

const RUN_ID = /^run_[a-z0-9]+$/;

/**
 * File-backed run store: one JSON file per run plus an idempotency index. Deliberately simple;
 * the interface is small enough to move to Postgres when there's more than one worker.
 */
export class FileRunStore {
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(private readonly dir: string) {}

  private get indexPath(): string {
    return join(this.dir, "idempotency.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexPath, "utf8")) as Record<string, IdempotencyEntry>;
      for (const [k, v] of Object.entries(raw)) this.idempotency.set(k, v);
    } catch {
      // No index yet.
    }
  }

  /** Synchronous lookup, so check-and-reserve can't interleave with another request. */
  getIdempotency(key: string): IdempotencyEntry | undefined {
    return this.idempotency.get(key);
  }

  reserveIdempotency(key: string, entry: IdempotencyEntry): void {
    this.idempotency.set(key, entry);
  }

  async persistIdempotency(): Promise<void> {
    await this.atomicWrite(this.indexPath, Object.fromEntries(this.idempotency));
  }

  async save(record: RunRecord): Promise<void> {
    await this.atomicWrite(join(this.dir, `${record.run_id}.json`), record);
  }

  async get(runId: string): Promise<RunRecord | null> {
    if (!RUN_ID.test(runId)) return null; // also blocks path traversal via the URL
    try {
      return JSON.parse(await readFile(join(this.dir, `${runId}.json`), "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = await this.get(runId);
    if (!current) throw new Error(`Unknown run ${runId}`);
    const next = { ...current, ...patch };
    await this.save(next);
    return next;
  }

  async listUnfinished(): Promise<RunRecord[]> {
    const files = (await readdir(this.dir)).filter((f) => RUN_ID.test(f.replace(/\.json$/, "")));
    const records = await Promise.all(files.map((f) => this.get(f.replace(/\.json$/, ""))));
    return records.filter((r): r is RunRecord => r !== null && (r.status === "queued" || r.status === "running"));
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, path);
  }
}
