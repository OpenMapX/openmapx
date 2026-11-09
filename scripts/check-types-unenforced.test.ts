import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkProject, formatReport, projects, run } from "./check-types-unenforced.mjs";

const roots: string[] = [];

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "check-types-unenforced-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const compilerOptions = { strict: true, noEmit: true, types: [] as string[] };
const tsconfig = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ compilerOptions, include: ["src"], ...extra });

function logger() {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-types-unenforced", () => {
  it("names configuration files that exist", () => {
    const root = join(import.meta.dirname, "..");
    for (const project of projects) expect(existsSync(join(root, project.config))).toBe(true);
  });

  it("counts the errors of a project without failing", () => {
    const root = workspace({
      "tsconfig.json": tsconfig(),
      "src/ok.ts": "export const ok: number = 1;\n",
      "src/bad.ts": 'export const a: number = "x";\nexport const b: string = 2;\n',
    });
    const result = checkProject({ name: "sample", config: "tsconfig.json" }, root);
    expect(result).toMatchObject({ name: "sample", files: 2, errors: 2, filesWithErrors: 1 });

    const log = logger();
    expect(run({ list: [{ name: "sample", config: "tsconfig.json" }], root, log })).toBe(0);
    expect(log.lines.join("\n")).toContain("2 errors");
  });

  it("reports a clean project as zero errors", () => {
    const root = workspace({
      "tsconfig.json": tsconfig(),
      "src/ok.ts": "export const ok = 1;\n",
    });
    expect(checkProject({ name: "clean", config: "tsconfig.json" }, root).errors).toBe(0);
  });

  it("fails when the configuration file is missing", () => {
    const root = workspace({});
    const log = logger();
    expect(run({ list: [{ name: "sample", config: "tsconfig.json" }], root, log })).toBe(1);
    expect(log.lines.join("\n")).toContain("cannot type-check sample");
  });

  it("fails when the configuration extends a file that does not exist", () => {
    const root = workspace({
      "tsconfig.json": tsconfig({ extends: "./missing.json" }),
      "src/ok.ts": "export const ok = 1;\n",
    });
    const log = logger();
    expect(run({ list: [{ name: "sample", config: "tsconfig.json" }], root, log })).toBe(1);
  });

  it("fails when the configuration matches no files", () => {
    const root = workspace({ "tsconfig.json": tsconfig({ include: ["nothing"] }) });
    const log = logger();
    expect(run({ list: [{ name: "sample", config: "tsconfig.json" }], root, log })).toBe(1);
  });

  it("fails when a declared type library cannot be found", () => {
    const root = workspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...compilerOptions, types: ["not-installed"] },
        include: ["src"],
      }),
      "src/ok.ts": "export const ok = 1;\n",
    });
    const log = logger();
    expect(run({ list: [{ name: "sample", config: "tsconfig.json" }], root, log })).toBe(1);
    expect(log.lines.join("\n")).toContain("TS2688");
  });

  it("stops at the first project that cannot be checked", () => {
    const root = workspace({
      "good/tsconfig.json": tsconfig(),
      "good/src/ok.ts": "export const ok = 1;\n",
    });
    const log = logger();
    const list = [
      { name: "broken", config: "broken/tsconfig.json" },
      { name: "good", config: "good/tsconfig.json" },
    ];
    expect(run({ list, root, log })).toBe(1);
    expect(log.lines.join("\n")).not.toContain("total");
  });

  it("appends a table to the step summary file", () => {
    const root = workspace({
      "tsconfig.json": tsconfig(),
      "src/bad.ts": 'export const a: number = "x";\n',
    });
    const summaryPath = join(root, "summary.md");
    const list = [{ name: "sample", config: "tsconfig.json" }];
    expect(run({ list, root, summaryPath, log: logger() })).toBe(0);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("| sample | 1 | 1 | 1 | `tsconfig.json` |");
    expect(summary).toContain("| **Total** | **1** |");
  });

  it("prints a total beside the per-project counts", () => {
    const report = formatReport([
      { name: "a", config: "a.json", files: 3, errors: 4, filesWithErrors: 2 },
      { name: "bb", config: "b.json", files: 5, errors: 6, filesWithErrors: 1 },
    ]);
    expect(report).toContain("total");
    expect(report).toContain("10 errors");
    expect(report).toContain("(8 files checked)");
  });
});
