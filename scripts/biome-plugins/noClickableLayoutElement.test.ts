import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("./noClickableLayoutElement.grit", import.meta.url));
const biome = fileURLToPath(new URL("../../node_modules/.bin/biome", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "clickable-layout-"));
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

describe("noClickableLayoutElement", () => {
  it("reports clickable layout components without a role or interactive element", () => {
    expect(
      reportedLines(`export const A = ({ f }: { f: () => void }) => (
  <div>
    <Box onClick={f}>row</Box>
    <Typography onClick={f}>link</Typography>
    <Stack onClick={f} />
    <Box component="div" onClick={f}>row</Box>
    <ListItem secondaryAction={<Box onClick={f} />}>item</ListItem>
  </div>
);
`),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  it("accepts interactive elements, explicit roles and nested props of other elements", () => {
    expect(
      reportedLines(`export const A = ({ f }: { f: () => void }) => (
  <div>
    <Box component="button" onClick={f}>row</Box>
    <Box component="input" type="radio" onClick={f} />
    <Box component="label" onClick={f}>row</Box>
    <Box component={Link} onClick={f}>row</Box>
    <Box role="button" tabIndex={0} onClick={f} onKeyDown={f}>row</Box>
    <ListItem secondaryAction={<IconButton onClick={f} />}>item</ListItem>
    <Button onClick={f}>button</Button>
    <ClickableRow onClick={f}>row</ClickableRow>
  </div>
);
`),
    ).toEqual([]);
  });

  it("exempts only literal interactive roles", () => {
    expect(
      reportedLines(`export const A = ({ f, r }: { f: () => void; r: string }) => (
  <div>
    <Box role="presentation" onClick={f}>row</Box>
    <Box role="none" onClick={f}>row</Box>
    <Box role="region" onClick={f}>row</Box>
    <Box role={r} onClick={f}>row</Box>
    <Box role="link" tabIndex={0} onClick={f} onKeyDown={f}>row</Box>
    <Box role="tab" tabIndex={0} onClick={f} onKeyDown={f}>row</Box>
    <Box role="menuitem" tabIndex={0} onClick={f} onKeyDown={f}>row</Box>
  </div>
);
`),
    ).toEqual([3, 4, 5, 6]);
  });

  it("honours a suppression with a reason", () => {
    expect(
      reportedLines(`export const A = ({ f }: { f: () => void }) => (
  <div>
    {/* biome-ignore lint/plugin/noClickableLayoutElement: background tap */}
    <Box onClick={f}>sheet</Box>
  </div>
);
`),
    ).toEqual([]);
  });
});
