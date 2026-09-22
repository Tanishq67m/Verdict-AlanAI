import { describe, expect, it } from "vitest";
import { toGeminiJsonSchema } from "@verdict/llm";
import { Action, describeAction, describeRef, PlannerOutput, plannerJsonSchema } from "../src/index.ts";

describe("closed action set", () => {
  it.each([
    { type: "navigate", url: "/events" },
    { type: "click", ref: "e12" },
    { type: "type", ref: "e3", text: "{{auth.email}}" },
    { type: "type", ref: "e4", text: "{{auth.password}}", submit: true },
    { type: "select", ref: "e7", option: "2" },
    { type: "wait_for", text: "Booking Confirmed" },
    { type: "wait_for", url_contains: "/my-tickets", timeout_ms: 5000 },
    { type: "assert", final: true, assertion: { kind: "text_visible", text: "Booking Confirmed!" } },
    { type: "assert", final: false, assertion: { kind: "element_text", ref: "e9", contains: "39" } },
    { type: "assert", final: true, assertion: { kind: "element_disabled", ref: "e2" } },
    { type: "conclude", summary: "Confirmation is visible" },
  ])("accepts %j", (action) => {
    expect(Action.safeParse(action).success).toBe(true);
  });

  it.each([
    ["free-form code", { type: "evaluate", script: "fetch('/api/bookings', {method:'POST'})" }],
    ["a CSS selector instead of a ref", { type: "click", ref: "#book-button" }],
    ["wait_for with both conditions", { type: "wait_for", text: "a", url_contains: "b" }],
    ["wait_for with no condition", { type: "wait_for" }],
    ["element_text with both equals and contains", { type: "assert", final: true, assertion: { kind: "element_text", ref: "e1", equals: "a", contains: "b" } }],
    ["assert without final", { type: "assert", assertion: { kind: "url_contains", value: "x" } }],
    ["extra keys", { type: "click", ref: "e1", force: true }],
    ["wait_for longer than 10 s", { type: "wait_for", text: "x", timeout_ms: 60_000 }],
  ])("rejects %s", (_name, action) => {
    expect(Action.safeParse(action).success).toBe(false);
  });

  it("planner output requires a thought and one action", () => {
    expect(PlannerOutput.safeParse({ thought: "Log in first", action: { type: "click", ref: "e5" } }).success).toBe(true);
    expect(PlannerOutput.safeParse({ action: { type: "click", ref: "e5" } }).success).toBe(false);
  });

  it("the JSON schema sent to Gemini lists all seven actions and uses no unsupported const keyword", () => {
    const json = JSON.stringify(toGeminiJsonSchema(plannerJsonSchema));
    for (const t of ["navigate", "click", "type", "select", "wait_for", "assert", "conclude"]) expect(json).toContain(`"${t}"`);
    expect(json).not.toContain('"const"');
  });

  it("describes actions without revealing typed secrets", () => {
    expect(describeAction({ type: "type", ref: "e4", text: "{{auth.password}}", submit: true })).toBe('type "{{auth.password}}" into e4 + Enter');
  });
});

describe("describeRef", () => {
  const snapshot = `- generic [active] [ref=e1]:
  - heading "Verdict Demo Night" [level=1] [ref=e2]
  - button "Confirm Booking" [ref=e12]
  - button "Sold out" [disabled] [ref=e13]
  - paragraph [ref=e14]: 40 seats left`;

  it("returns the role and name for a ref", () => {
    expect(describeRef(snapshot, "e12")).toBe('button "Confirm Booking"');
    expect(describeRef(snapshot, "e13")).toBe('button "Sold out"');
    expect(describeRef(snapshot, "e2")).toBe('heading "Verdict Demo Night"');
    expect(describeRef(snapshot, "e1")).toBe("generic");
    expect(describeRef(snapshot, "e99")).toBeNull();
  });
});

describe("refs after navigation", () => {
  it("accepts frame-prefixed refs that Playwright emits after a navigation", () => {
    expect(Action.safeParse({ type: "click", ref: "f1e12" }).success).toBe(true);
    expect(Action.safeParse({ type: "click", ref: "f12" }).success).toBe(false);
    expect(describeRef('  - textbox "Email" [ref=f1e3]', "f1e3")).toBe('textbox "Email"');
  });
});
