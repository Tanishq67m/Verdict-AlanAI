import { describe, expect, it } from "vitest";
import { parseSpec, SpecError, HARD_LIMITS } from "../src/index.ts";

const env = {
  PREVIEW_URL: "https://preview.example.com",
  VERDICT_TEST_EMAIL: "tester@example.com",
  VERDICT_TEST_PASSWORD: "s3cret-pass",
};

// The PRD's spec, with secrets written as ${VAR} (PLAN.md C-3).
const PRD_SPEC = `
version: 1
task: ENG-204 Ticket booking
base_url: \${PREVIEW_URL}
auth:
  email: \${VERDICT_TEST_EMAIL}
  password: \${VERDICT_TEST_PASSWORD}
criteria:
  - id: book-ticket
    check: A logged-in user can book one ticket for "Demo Night" and sees a confirmation.
  - id: seat-count
    check: After booking, the remaining seat count for "Demo Night" drops by exactly 1.
  - id: sold-out
    check: When an event is sold out, the Book button is disabled and no booking is created.
limits:
  max_steps_per_criterion: 15
  timeout_seconds: 300
`;

function specWith(overrides: string): string {
  return `
version: 1
task: T
base_url: https://app.example.com
criteria:
  - id: book-ticket
    check: A user can book one ticket and sees a confirmation.
${overrides}`;
}

describe("task spec v1", () => {
  it("parses the PRD example and fills ${VAR} from env", () => {
    const spec = parseSpec(PRD_SPEC, { env });
    expect(spec.base_url).toBe("https://preview.example.com");
    expect(spec.auth).toEqual({ email: "tester@example.com", password: "s3cret-pass" });
    expect(spec.criteria.map((c) => c.id)).toEqual(["book-ticket", "seat-count", "sold-out"]);
    expect(spec.limits).toEqual({ max_steps_per_criterion: 15, timeout_seconds: 300 });
  });

  it("applies default limits when the block is omitted", () => {
    const spec = parseSpec(specWith(""), { env: {} });
    expect(spec.limits).toEqual({ max_steps_per_criterion: 15, timeout_seconds: 300 });
    expect(spec.auth).toBeUndefined();
  });

  it("lets --url override base_url, even when base_url references an unset variable", () => {
    const spec = parseSpec(PRD_SPEC, { env: { ...env, PREVIEW_URL: undefined }, baseUrl: "http://localhost:3000" });
    expect(spec.base_url).toBe("http://localhost:3000");
  });

  it("names every missing environment variable", () => {
    expect(() => parseSpec(PRD_SPEC, { env: { PREVIEW_URL: "https://x.dev" } })).toThrow(
      /Missing environment variable\(s\): VERDICT_TEST_EMAIL, VERDICT_TEST_PASSWORD/,
    );
  });

  it("rejects GitHub ${{ secrets.X }} syntax with an explanation", () => {
    const yaml = specWith("auth:\n  email: ${{ secrets.EMAIL }}\n  password: x");
    expect(() => parseSpec(yaml, { env: {} })).toThrow(/GitHub Actions syntax/);
  });

  it("does not let an env value inject YAML structure", () => {
    const spec = parseSpec(PRD_SPEC, { env: { ...env, VERDICT_TEST_PASSWORD: "x\nlimits:\n  timeout_seconds: 9999" } });
    expect(spec.auth?.password).toBe("x\nlimits:\n  timeout_seconds: 9999");
    expect(spec.limits.timeout_seconds).toBe(300);
  });

  it.each([
    ["steps above the hard limit", "limits:\n  max_steps_per_criterion: 16"],
    ["timeout above the hard limit", "limits:\n  timeout_seconds: 301"],
    ["unknown top-level key", "retries: 3"],
    ["unknown limits key", "limits:\n  max_steps: 5"],
  ])("rejects %s", (_name, extra) => {
    expect(() => parseSpec(specWith(extra), { env: {} })).toThrow(SpecError);
  });

  it(`rejects more than ${HARD_LIMITS.maxCriteria} criteria`, () => {
    const criteria = Array.from({ length: 11 }, (_, i) => `  - id: c${i}\n    check: Criterion number ${i} holds.`).join("\n");
    const yaml = `version: 1\ntask: T\nbase_url: https://a.dev\ncriteria:\n${criteria}\n`;
    expect(() => parseSpec(yaml, { env: {} })).toThrow(SpecError);
  });

  it("rejects duplicate criterion ids", () => {
    const yaml = specWith("  - id: book-ticket\n    check: The same id appears twice here.").replace(/\n\n?$/, "");
    expect(() => parseSpec(yaml, { env: {} })).toThrow(/duplicate criterion id "book-ticket"/);
  });

  it.each(["ftp://files.example.com", "javascript:alert(1)", "not a url"])("rejects base_url %s", (url) => {
    expect(() => parseSpec(specWith(""), { env: {}, baseUrl: url })).toThrow(SpecError);
  });

  it("rejects wrong version and malformed YAML", () => {
    expect(() => parseSpec(specWith("").replace("version: 1", "version: 2"), { env: {} })).toThrow(SpecError);
    expect(() => parseSpec("criteria: [", { env: {} })).toThrow(/Invalid YAML/);
    expect(() => parseSpec("- just\n- a list", { env: {} })).toThrow(/mapping/);
  });
});
