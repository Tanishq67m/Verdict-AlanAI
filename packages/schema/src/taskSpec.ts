import { z } from "zod";

/**
 * Hard limits from the PRD ("Reliability → Hard limits"). A spec may ask for
 * less, never more: these protect the worker, not the app under test.
 */
export const HARD_LIMITS = {
  maxCriteria: 10,
  maxStepsPerCriterion: 15,
  maxTimeoutSeconds: 300,
} as const;

export const CriterionSpecSchema = z.strictObject({
  /** Stable id used in verdicts, PR comments and reruns, e.g. `book-ticket`. */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be lowercase letters, digits and dashes (max 63 chars)"),
  /** The acceptance criterion in plain English. */
  check: z.string().trim().min(10, "should be a full sentence").max(500),
});

export const AuthSpecSchema = z.strictObject({
  email: z.string().min(1),
  password: z.string().min(1),
});

export const LimitsSpecSchema = z
  .strictObject({
    max_steps_per_criterion: z
      .int()
      .min(1)
      .max(HARD_LIMITS.maxStepsPerCriterion)
      .default(HARD_LIMITS.maxStepsPerCriterion),
    timeout_seconds: z.int().min(10).max(HARD_LIMITS.maxTimeoutSeconds).default(HARD_LIMITS.maxTimeoutSeconds),
  })
  // prefault (not default) so an omitted `limits` block still gets each field's default.
  .prefault({});

export const TaskSpecV1Schema = z.strictObject({
  version: z.literal(1),
  task: z.string().trim().min(1).max(200),
  base_url: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }),
  auth: AuthSpecSchema.optional(),
  criteria: z
    .array(CriterionSpecSchema)
    .min(1)
    .max(HARD_LIMITS.maxCriteria)
    .superRefine((criteria, ctx) => {
      const seen = new Set<string>();
      for (const [i, c] of criteria.entries()) {
        if (seen.has(c.id)) {
          ctx.addIssue({ code: "custom", message: `duplicate criterion id "${c.id}"`, path: [i, "id"] });
        }
        seen.add(c.id);
      }
    }),
  limits: LimitsSpecSchema,
});

export type TaskSpec = z.output<typeof TaskSpecV1Schema>;
export type TaskSpecInput = z.input<typeof TaskSpecV1Schema>;
export type CriterionSpec = z.output<typeof CriterionSpecSchema>;
export type AuthSpec = z.output<typeof AuthSpecSchema>;
