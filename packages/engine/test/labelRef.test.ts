import { describe, expect, it } from "vitest";
import { labelRef } from "../src/loop.ts";

describe("labelRef", () => {
  it("replaces the snapshot ref with what a reviewer sees", () => {
    expect(labelRef("click f1e241", "f1e241", 'button "Confirm Booking"')).toBe('click button "Confirm Booking"');
    expect(labelRef('f1e75 text is "1/40 registered"', "f1e75", 'paragraph "1/40 registered"')).toBe(
      'paragraph "1/40 registered" text is "1/40 registered"',
    );
  });

  it("does not touch a longer ref that starts the same", () => {
    expect(labelRef("click e12", "e1", "button")).toBe("click e12");
  });

  it("keeps the text when there is no label", () => {
    expect(labelRef("click e3", "e3", null)).toBe("click e3");
  });
});
