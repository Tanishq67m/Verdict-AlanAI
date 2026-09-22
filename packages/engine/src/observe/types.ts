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
 * The "eyes" are swappable (D-5): M1 ships the Playwright accessibility snapshot,
 * M1.5 adds VisionStream behind this same interface and compares the two.
 */
export interface Observer {
  readonly name: string;
  observe(page: Page): Promise<Observation>;
}
