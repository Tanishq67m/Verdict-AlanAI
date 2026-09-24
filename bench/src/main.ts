/** `pnpm bench:summarize <resultsDir>`: writes summary.json + summary.md into <resultsDir> and prints the markdown. */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuns, renderMarkdown, summarizeBench, type BugSpec } from "./summarize.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: pnpm bench:summarize <resultsDir>");
  process.exit(64);
}
const bugsPath = resolve(fileURLToPath(new URL("../bugs.json", import.meta.url)));
const bugs = JSON.parse(await readFile(bugsPath, "utf8")) as BugSpec[];
const summary = summarizeBench(await loadRuns(dir), bugs);
const md = renderMarkdown(summary);
await writeFile(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(dir, "summary.md"), md);
process.stdout.write(md);
