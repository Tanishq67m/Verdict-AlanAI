import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { newRunId } from "@verdict/engine";
import { TaskSpecV1Schema, type TaskSpec, type Verdict } from "@verdict/schema";
import { z } from "zod";
import { SerialQueue } from "./queue.ts";
import type { FileRunStore, RunRecord } from "./store.ts";

/** Runs a validated spec and returns its verdict. The real one drives a browser; tests pass a fake. */
export type Executor = (spec: TaskSpec, options: { runId: string; criterionIds: string[]; commit: string | null }) => Promise<Verdict>;

export interface ServerDeps {
  store: FileRunStore;
  executor: Executor;
  apiKey: string;
  queue?: SerialQueue;
}

const CreateRunBody = z.strictObject({
  /** The task spec as JSON: the same fields as .verdict.yml (values are literal; no ${VAR} expansion). */
  spec: z.record(z.string(), z.unknown()),
  /** Overrides spec.base_url, e.g. a preview URL. */
  url: z.string().optional(),
  /** Run only these criteria (default: all). */
  criteria: z.array(z.string()).max(10).optional(),
  commit: z.string().max(64).optional(),
});

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Stable JSON (sorted keys) so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function view(r: RunRecord) {
  return { ...r, links: { self: `/v1/runs/${r.run_id}` } };
}

export function buildServer(deps: ServerDeps): { app: FastifyInstance; queue: SerialQueue } {
  const { store, executor } = deps;
  const queue = deps.queue ?? new SerialQueue();
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const expectedKey = sha256(deps.apiKey);

  app.get("/healthz", async () => ({ ok: true, queued: queue.pending }));

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/")) return;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Compare hashes so the comparison is constant-time regardless of key length.
    if (!presented || !timingSafeEqual(sha256(presented), expectedKey)) {
      return reply.code(401).send({ error: "Missing or invalid API key (Authorization: Bearer <key>)" });
    }
  });

  app.post("/v1/runs", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
      return reply.code(400).send({ error: "Idempotency-Key header is required (1-255 visible ASCII characters), e.g. <repo>:<commit>:<spec-hash>" });
    }

    const body = CreateRunBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `Invalid request body:\n${z.prettifyError(body.error)}` });
    const specResult = TaskSpecV1Schema.safeParse({ ...body.data.spec, ...(body.data.url ? { base_url: body.data.url } : {}) });
    if (!specResult.success) return reply.code(400).send({ error: `Invalid task spec:\n${z.prettifyError(specResult.error)}` });
    const spec = specResult.data;
    const criterionIds = body.data.criteria ?? [];
    const unknown = criterionIds.filter((id) => !spec.criteria.some((c) => c.id === id));
    if (unknown.length) return reply.code(400).send({ error: `Unknown criteria: ${unknown.join(", ")}` });

    // The hash identifies "the same request". Credentials are left out so no hash of a password is stored.
    const { auth: _auth, ...specWithoutAuth } = body.data.spec;
    const bodyHash = sha256(canonical({ ...body.data, spec: specWithoutAuth })).toString("hex");

    const existing = store.getIdempotency(key);
    if (existing) {
      if (existing.body_hash !== bodyHash) {
        return reply.code(409).send({ error: "This Idempotency-Key was already used with a different request body", run_id: existing.run_id });
      }
      const record = await store.get(existing.run_id);
      if (record) return reply.code(200).header("Idempotent-Replayed", "true").send(view(record));
    }

    const runId = newRunId();
    store.reserveIdempotency(key, { run_id: runId, body_hash: bodyHash }); // synchronous: no race with a duplicate request
    const record: RunRecord = {
      run_id: runId,
      status: "queued",
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      request: { task: spec.task, base_url: spec.base_url, criteria: criterionIds.length ? criterionIds : spec.criteria.map((c) => c.id), commit: body.data.commit ?? null },
      verdict: null,
      error: null,
    };
    await store.save(record);
    await store.persistIdempotency();

    queue.push(async () => {
      await store.update(runId, { status: "running", started_at: new Date().toISOString() });
      try {
        const verdict = await executor(spec, { runId, criterionIds, commit: body.data.commit ?? null });
        await store.update(runId, { status: "done", verdict, finished_at: new Date().toISOString() });
      } catch (err) {
        await store.update(runId, { status: "failed", error: err instanceof Error ? err.message : String(err), finished_at: new Date().toISOString() });
      }
    });

    return reply.code(202).send(view(record));
  });

  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (req, reply) => {
    const record = await store.get(req.params.id);
    if (!record) return reply.code(404).send({ error: `No run ${req.params.id}` });
    return view(record);
  });

  return { app, queue };
}
