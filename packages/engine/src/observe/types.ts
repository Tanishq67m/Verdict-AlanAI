import type { Page } from "playwright";

/** What the planner sees of the page at one step. */
export interface Observation {
  url: string;
  title: string;
  /** Text description of the page; element refs like `[ref=e12]` are what actions target. */
  content: string;
  truncated: boolean;
}

/**
 * The "eyes" are swappable: Verdict ships the Playwright accessibility snapshot, and another
 * observer can be added behind this interface without touching the loop.
 */
export interface Observer {
  readonly name: string;
  observe(page: Page): Promise<Observation>;
}
