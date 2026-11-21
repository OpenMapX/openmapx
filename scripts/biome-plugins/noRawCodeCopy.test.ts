import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("./noRawCodeCopy.grit", import.meta.url));
const biome = fileURLToPath(new URL("../../node_modules/.bin/biome", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "raw-code-copy-"));
writeFileSync(join(dir, "biome.json"), JSON.stringify({ plugins: [plugin] }));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Lines of `body`, placed on line 2 of a component, that the plugin reports. */
function reported(body: string): number[] {
  writeFileSync(
    join(dir, "fixture.tsx"),
    `export const A = ({ t, job, stage, label }: Props) => (
  <div>${body}</div>
);
`,
  );
  let output: string;
  try {
    output = execFileSync(biome, ["lint", "--reporter=json", "fixture.tsx"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // Biome exits non-zero when it reports an error; the report is still on stdout.
    output = (error as { stdout: string }).stdout;
  }
  const report = JSON.parse(output) as {
    diagnostics: { category: string; location: { start: { line: number } } }[];
  };
  return report.diagnostics
    .filter((diagnostic) => diagnostic.category === "plugin")
    .map((diagnostic) => diagnostic.location.start.line);
}

describe("noRawCodeCopy", () => {
  it.each([
    ["a code field as a child", "{job.status}", `{t("jobStatus", { status: job.status })}`],
    [
      "a code field in a shown prop",
      "<Chip label={stage.state} />",
      "<Chip label={label(stage.state)} />",
    ],
    [
      "a code field in a template child",
      `{\`\${stage.direction} · \${stage.state}\`}`,
      `{t("stage", { direction: stage.direction })}`,
    ],
    [
      "a code field as a ternary branch",
      "{job ? job.action : null}",
      "{job ? label(job.action) : null}",
    ],
    [
      "a code field after &&",
      `<Chip title={job && job.source} />`,
      "<Chip title={job && label(job.source)} />",
    ],
  ])("reports %s and accepts the worded form", (_shape, raw, worded) => {
    expect(reported(raw)).toEqual([2]);
    expect(reported(worded)).toEqual([]);
  });

  it("accepts codes used as logic, keys and props that show no text", () => {
    expect(
      reported(`<Chip color={job.status === "failed" ? "error" : "default"} key={job.status} />`),
    ).toEqual([]);
    expect(reported("<Item value={job.source} data-state={stage.state} />")).toEqual([]);
    expect(reported("{job.reason}")).toEqual([]);
  });
});
