import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/index.ts";

describe(".verdict.example.yml", () => {
  it("is a valid v1 spec with the book-ticket criterion", async () => {
    const text = await readFile(new URL("../../../.verdict.example.yml", import.meta.url), "utf8");
    const spec = parseSpec(text, { env: { PREVIEW_URL: "http://localhost:3000", VERDICT_TEST_EMAIL: "a@b.co", VERDICT_TEST_PASSWORD: "pw123" } });
    expect(spec.criteria).toEqual([{ id: "book-ticket", check: 'A logged-in user can book one ticket for "Verdict Demo Night" and sees a confirmation.' }]);
    expect(spec.limits).toEqual({ max_steps_per_criterion: 15, timeout_seconds: 300 });
  });
});
