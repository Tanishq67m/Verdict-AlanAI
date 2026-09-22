import { z } from "zod";

/**
 * The closed action set (PRD → Verification engine). The LLM can only ever pick one of these;
 * nothing here executes free-form code. `conclude` is a control signal, not a browser action
 * (PLAN.md C-5): it's how the planner says "end state reached, judge me".
 */

const Ref = z
  .string()
  // Refs look like "e12" on the first document and gain a frame prefix after a navigation ("f1e12").
  .regex(/^(?:f\d+)?e\d+$/)
  .describe('Element ref copied exactly from the LATEST page snapshot, e.g. "e12" or "f1e12"');
const Text = z.string().min(1).max(300);

export const NavigateAction = z.strictObject({
  type: z.literal("navigate"),
  url: z.string().min(1).max(2000).describe("Absolute URL on the app, or a path relative to the base URL"),
});
export const ClickAction = z.strictObject({ type: z.literal("click"), ref: Ref });
export const TypeAction = z.strictObject({
  type: z.literal("type"),
  ref: Ref,
  text: z.string().max(500).describe("Text to enter. For credentials use exactly {{auth.email}} or {{auth.password}}"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
});
export const SelectAction = z.strictObject({
  type: z.literal("select"),
  ref: Ref,
  option: Text.describe("Visible label or value of the option"),
});
export const WaitForAction = z
  .strictObject({
    type: z.literal("wait_for"),
    text: Text.optional().describe("Wait until this text is visible"),
    url_contains: Text.optional().describe("Wait until the URL contains this"),
    timeout_ms: z.int().min(100).max(10_000).optional(),
  })
  .refine((a) => (a.text === undefined) !== (a.url_contains === undefined), {
    message: "wait_for needs exactly one of text or url_contains",
  });

export const Assertion = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text_visible"), text: Text }),
  z.strictObject({ kind: z.literal("text_not_visible"), text: Text }),
  z
    .strictObject({
      kind: z.literal("element_text"),
      ref: Ref,
      equals: Text.optional(),
      contains: Text.optional(),
    })
    .refine((a) => (a.equals === undefined) !== (a.contains === undefined), {
      message: "element_text needs exactly one of equals or contains",
    }),
  z.strictObject({ kind: z.literal("element_enabled"), ref: Ref }),
  z.strictObject({ kind: z.literal("element_disabled"), ref: Ref }),
  z.strictObject({ kind: z.literal("url_contains"), value: Text }),
]);

export const AssertAction = z.strictObject({
  type: z.literal("assert"),
  assertion: Assertion,
  final: z
    .boolean()
    .describe("true if this assertion checks the criterion's END STATE (it decides pass/fail); false for an intermediate check"),
});

export const ConcludeAction = z.strictObject({
  type: z.literal("conclude"),
  summary: z.string().min(1).max(500).describe("The end state you reached and what you observed"),
});

export const Action = z.discriminatedUnion("type", [
  NavigateAction,
  ClickAction,
  TypeAction,
  SelectAction,
  WaitForAction,
  AssertAction,
  ConcludeAction,
]);

export const PlannerOutput = z.strictObject({
  thought: z.string().max(600).describe("One or two sentences: what you see and why you chose this action"),
  action: Action,
});

export const LlmJudgment = z.strictObject({
  result: z.enum(["pass", "fail", "inconclusive"]),
  expected: z.string().min(1).max(500),
  observed: z.string().min(1).max(500),
  reason: z.string().min(1).max(800),
});

export type Action = z.output<typeof Action>;
export type Assertion = z.output<typeof Assertion>;
export type PlannerOutput = z.output<typeof PlannerOutput>;
export type LlmJudgment = z.output<typeof LlmJudgment>;

export const plannerJsonSchema = z.toJSONSchema(PlannerOutput) as Record<string, unknown>;
export const judgmentJsonSchema = z.toJSONSchema(LlmJudgment) as Record<string, unknown>;

/** Short human-readable form for traces, logs and repair hints. Never contains secrets. */
export function describeAction(action: Action): string {
  switch (action.type) {
    case "navigate":
      return `navigate ${action.url}`;
    case "click":
      return `click ${action.ref}`;
    case "type":
      return `type ${JSON.stringify(action.text)} into ${action.ref}${action.submit ? " + Enter" : ""}`;
    case "select":
      return `select ${JSON.stringify(action.option)} in ${action.ref}`;
    case "wait_for":
      return action.text !== undefined ? `wait_for text ${JSON.stringify(action.text)}` : `wait_for url_contains ${JSON.stringify(action.url_contains)}`;
    case "assert":
      return `assert${action.final ? " (final)" : ""} ${describeAssertion(action.assertion)}`;
    case "conclude":
      return "conclude";
  }
}

export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case "text_visible":
      return `text visible ${JSON.stringify(a.text)}`;
    case "text_not_visible":
      return `text not visible ${JSON.stringify(a.text)}`;
    case "element_text":
      return a.equals !== undefined ? `${a.ref} text equals ${JSON.stringify(a.equals)}` : `${a.ref} text contains ${JSON.stringify(a.contains)}`;
    case "element_enabled":
      return `${a.ref} enabled`;
    case "element_disabled":
      return `${a.ref} disabled`;
    case "url_contains":
      return `url contains ${JSON.stringify(a.value)}`;
  }
}
