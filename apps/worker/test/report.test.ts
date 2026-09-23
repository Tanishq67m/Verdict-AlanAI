import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report/html.ts";

describe("HTML report", () => {
  it("is self-contained: steps, hints and the screenshot inlined, text escaped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-report-"));
    await writeFile(join(dir, "book-ticket-attempt1-step7.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const html = await renderReport(
      {
        run_id: "run_1", status: "fail", commit: "a1b2c3d4", summary: { passed: 0, failed: 1, error: 0, inconclusive: 0 },
        criteria: [{ id: "book-ticket", result: "fail", expected: "Confirmation shown", observed: "Uncaught TypeError <script>", failing_step: 7,
          evidence: { screenshot_url: null, trace_url: null, console_errors: ["[step 7] Uncaught TypeError"], failed_requests: [] }, repair_hint: "Check the Confirm Booking handler" }],
        cost: { llm_tokens: 1000, usd: 0.01 }, duration_ms: 30_000,
      },
      { "book-ticket": [{ attempt: 1, result: "fail", decided_by: "console", steps: [
        { step: 7, thought: "Book it", action: { type: "click", ref: "e12" }, target: 'button "Confirm Booking"', ok: true, outcome: "clicked", url: "http://x", elapsed_ms: 1 },
      ] }] },
      dir,
    );
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain('click button &quot;Confirm Booking&quot;');
    expect(html).toContain("Check the Confirm Booking handler");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/https?:\/\/(?!x")/); // no external assets
  });
});
