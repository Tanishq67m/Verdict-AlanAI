import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODES, EXIT_USAGE, main } from "../src/main.ts";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), env }, out, err };
}

describe("verdict CLI", () => {
  it("prints help with exit 0", async () => {
    const t = io();
    expect(await main(["--help"], t.io)).toBe(0);
    expect(t.out.join("")).toContain("pnpm verdict run --spec");
  });

  it("rejects unknown commands, unknown flags and a missing --spec with the usage exit code", async () => {
    expect(await main(["verify"], io().io)).toBe(EXIT_USAGE);
    expect(await main(["run", "--spec", "x.yml", "--bogus"], io().io)).toBe(EXIT_USAGE);
    const t = io();
    expect(await main(["run"], t.io)).toBe(EXIT_USAGE);
    expect(t.err.join("")).toContain("Missing --spec");
  });

  it("reports spec problems before launching anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-cli-"));
    const spec = join(dir, "spec.yml");
    await writeFile(spec, "version: 1\ntask: t\nbase_url: ${PREVIEW_URL}\ncriteria:\n  - id: a\n    check: Something visible happens.\n");
    const t = io({});
    expect(await main(["run", "--spec", spec, "--dotenv", join(dir, "none.env")], t.io)).toBe(EXIT_USAGE);
    expect(t.err.join("")).toContain("Missing environment variable(s): PREVIEW_URL");
  });

  it("requires GEMINI_API_KEY once the spec is valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-cli-"));
    const spec = join(dir, "spec.yml");
    await writeFile(spec, "version: 1\ntask: t\nbase_url: http://localhost:3000\ncriteria:\n  - id: a\n    check: Something visible happens.\n");
    const t = io({});
    expect(await main(["run", "--spec", spec, "--dotenv", join(dir, "none.env")], t.io)).toBe(EXIT_USAGE);
    expect(t.err.join("")).toContain("GEMINI_API_KEY is not set");
  });

  it("maps results to distinct exit codes", () => {
    expect(EXIT_CODES).toEqual({ pass: 0, fail: 1, error: 2, inconclusive: 3 });
  });
});
