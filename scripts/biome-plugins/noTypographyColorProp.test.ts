import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("./noTypographyColorProp.grit", import.meta.url));
const biome = fileURLToPath(new URL("../../node_modules/.bin/biome", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "typography-color-"));
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

describe("noTypographyColorProp", () => {
  it("reports palette paths, hex colours and expressions on Typography", () => {
    expect(
      reportedLines(`export const A = ({ ok, brand }: { ok: boolean; brand: string }) => (
  <div>
    <Typography color="text.secondary">a</Typography>
    <Typography variant="caption" color="warning.main" />
    <Typography color="#fff">b</Typography>
    <Typography color={brand}>c</Typography>
    <Typography color={ok ? "success" : "error"}>d</Typography>
  </div>
);
`),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  it("accepts Typography's own colour variants, sx and other components' colour props", () => {
    expect(
      reportedLines(`export const A = () => (
  <div>
    <Typography color="textSecondary">a</Typography>
    <Typography color="error">b</Typography>
    <Typography color="inherit">c</Typography>
    <Typography sx={{ color: "text.secondary" }}>d</Typography>
    <Link color="text.secondary">e</Link>
    <Typography title={<Box color="text.secondary" />}>f</Typography>
  </div>
);
`),
    ).toEqual([]);
  });
});
