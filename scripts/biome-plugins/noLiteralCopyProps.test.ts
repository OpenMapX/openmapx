import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("./noLiteralCopyProps.grit", import.meta.url));
const biome = fileURLToPath(new URL("../../node_modules/.bin/biome", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "literal-copy-props-"));
writeFileSync(join(dir, "biome.json"), JSON.stringify({ plugins: [plugin] }));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Lines of `source` the plugin reports. */
function reportedLines(source: string): number[] {
  writeFileSync(join(dir, "fixture.tsx"), source);
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

describe("noLiteralCopyProps", () => {
  it("reports words written into props that show text", () => {
    expect(
      reportedLines(`export const A = () => (
  <div>
    <TextField label="Reason (optional)" />
    <Tooltip title={"Back to map"} />
    <IconButton aria-label='Close' />
    <Header subtitle={\`Accounts and roles\`} />
    <Checkbox aria-label={\`Select \${service.id}\`} />
  </div>
);
`),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  it("accepts translated copy, separators and props that carry no copy", () => {
    expect(
      reportedLines(`export const A = ({ t }: { t: (key: string) => string }) => (
  <div>
    <TextField label={t("reason")} variant="outlined" />
    <Chip label="·" color="primary" />
    <Box title={name} component="section" />
    <Chip label={\`v\${detail.version}\`} secondary={\`\${row.state} · \${row.dueAt}\`} />
  </div>
);
`),
    ).toEqual([]);
  });
});
