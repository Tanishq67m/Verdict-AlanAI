import type { BeforeAttemptHook } from "@verdict/engine";
import { z } from "zod";

/**
 * Test-data reset for EventPulse: before every attempt, log in to EventPulse's API as the
 * test user and cancel their active bookings (cancelling also releases the seat).
 *
 * Why: EventPulse allows one active booking per user per ticket type, so without a reset a
 * second run (or a flake rerun) of `book-ticket` gets a 409, and `seat-count` would start
 * from the wrong number. This only ever touches the test user's own bookings.
 */

export interface EventPulseResetOptions {
  /** EventPulse API base, e.g. http://localhost:5001/api */
  apiUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const LoginResponse = z.object({ data: z.object({ tokens: z.object({ accessToken: z.string().min(1) }) }) });
const BookingsResponse = z.object({
  data: z.array(z.object({ id: z.string(), status: z.string(), checkedIn: z.boolean().optional() })),
});

export function eventPulseReset(options: EventPulseResetOptions): BeforeAttemptHook {
  const base = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // One API login per run, reused across criteria: EventPulse allows only 20 auth requests / 15 min.
  let token: string | null = null;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    doFetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const failure = (what: string, res: Response): Error =>
    new Error(
      `${what} failed (HTTP ${res.status})${res.status === 429 ? ": EventPulse's rate limit was hit; wait ~15 minutes and re-run" : ""}`,
    );

  const login = async (): Promise<void> => {
    token = null;
    const res = await call("POST", "/auth/login", { email: options.email, password: options.password });
    if (!res.ok) throw failure("EventPulse login as the test user", res);
    token = LoginResponse.parse(await res.json()).data.tokens.accessToken;
  };

  return async ({ logger }) => {
    if (!token) await login();
    let res = await call("GET", "/bookings/my");
    if (res.status === 401) {
      await login();
      res = await call("GET", "/bookings/my");
    }
    if (!res.ok) throw failure("Listing the test user's bookings", res);
    const active = BookingsResponse.parse(await res.json()).data.filter(
      (b) => (b.status === "CONFIRMED" || b.status === "PENDING") && !b.checkedIn,
    );
    for (const booking of active) {
      const cancel = await call("DELETE", `/bookings/${encodeURIComponent(booking.id)}/cancel`);
      if (!cancel.ok) throw failure(`Cancelling booking ${booking.id}`, cancel);
    }
    logger.info("test_data_reset", { app: "eventpulse", cancelled_bookings: active.length });
  };
}
