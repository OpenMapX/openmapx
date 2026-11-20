import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("./noLiteralCopy.grit", import.meta.url));
const biome = fileURLToPath(new URL("../../node_modules/.bin/biome", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "literal-copy-"));
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

/** Wraps `body` as line 2 of a component that has a translator and some values. */
function component(body: string): string {
  return `export const A = ({ t, x, on, showToast, reportJob, setError }: Props) => (
  <div>${body}</div>
);
`;
}

/** Puts `statement` on line 2 of a function body with the same values in scope. */
function statement(body: string): string {
  return `export function a({ t, x, on, showToast, reportJob, setError }: Props) {
  ${body}
}
`;
}

const shapes: { shape: string; literal: string; translated: string }[] = [
  {
    shape: "a string literal as a JSX expression child",
    literal: component(`{"Literal in braces"}`),
    translated: component(`{t("literalInBraces")}`),
  },
  {
    shape: "a ternary branch as a child",
    literal: component(`{on ? "Shown" : "Hidden"}`),
    translated: component(`{on ? t("shown") : t("hidden")}`),
  },
  {
    shape: "a ?? fallback as a child",
    literal: component(`{x ?? "none"}`),
    translated: component(`{x ?? t("none")}`),
  },
  {
    shape: "an || fallback as a child",
    literal: component(`{x.join(", ") || "none"}`),
    translated: component(`{x.join(", ") || t("none")}`),
  },
  {
    shape: "concatenation as a child",
    literal: component(`{"Version " + x}`),
    translated: component(`{t("version", { version: x })}`),
  },
  {
    shape: "a template literal as a child",
    literal: component(`{\`Queued as \${x}\`}`),
    translated: component(`{t("queuedAs", { jobId: x })}`),
  },
  {
    shape: "a literal copy prop",
    literal: component(`<TextField label="Reason (optional)" />`),
    translated: component(`<TextField label={t("reasonOptional")} />`),
  },
  {
    shape: "a ternary in a copy prop",
    literal: component(`<Chip label={on ? "required" : "optional"} />`),
    translated: component(`<Chip label={on ? t("required") : t("optional")} />`),
  },
  {
    shape: "a ?? fallback in a copy prop",
    literal: component(`<Chip label={x ?? "Unknown"} />`),
    translated: component(`<Chip label={x ?? t("unknown")} />`),
  },
  {
    shape: "concatenation in a copy prop",
    literal: component(`<Chip label={"Prefix " + x} />`),
    translated: component(`<Chip label={t("prefixed", { value: x })} />`),
  },
  {
    shape: "a template literal in a copy prop",
    literal: component(`<Checkbox aria-label={\`Select \${x}\`} />`),
    translated: component(`<Checkbox aria-label={t("select", { name: x })} />`),
  },
  {
    shape: "a heading prop",
    literal: component(`<Section heading="Danger zone" />`),
    translated: component(`<Section heading={t("dangerZone")} />`),
  },
  {
    shape: "a noOptionsText prop",
    literal: component(`<Autocomplete noOptionsText="No matches" />`),
    translated: component(`<Autocomplete noOptionsText={t("noMatches")} />`),
  },
  {
    shape: "a caption prop",
    literal: component(`<Figure caption="Feeds by state" />`),
    translated: component(`<Figure caption={t("feedsByState")} />`),
  },
  {
    shape: "an aria-description prop",
    literal: component(`<Box aria-description="Opens the detail" />`),
    translated: component(`<Box aria-description={t("opensDetail")} />`),
  },
  {
    shape: "a confirmText prop",
    literal: component(`<Confirm confirmText="Delete it" />`),
    translated: component(`<Confirm confirmText={t("deleteIt")} />`),
  },
  {
    shape: "a toast with literal copy",
    literal: statement(`showToast("Saved the source", "success");`),
    translated: statement(`showToast(t("savedSource"), "success");`),
  },
  {
    shape: "a toast with a template message",
    literal: statement(`toast.error(\`Could not save \${x}\`);`),
    translated: statement(`toast.error(t("couldNotSave", { name: x }));`),
  },
  {
    shape: "a snackbar with literal copy",
    literal: statement(`enqueueSnackbar("Copied");`),
    translated: statement(`enqueueSnackbar(t("copied"));`),
  },
  {
    shape: "an error setter with literal copy",
    literal: statement(`setError(on ? "Upload failed" : null);`),
    translated: statement(`setError(on ? t("uploadFailed") : null);`),
  },
  {
    shape: "a job report with a template message",
    literal: statement(`reportJob(x, \`Transit sync queued as \${x}.\`);`),
    translated: statement(`reportJob(x, t("transitSyncQueued", { jobId: x }));`),
  },
  {
    shape: "a literal value handed to a translator",
    literal: statement(`return t("integrationState", { state: on ? "enabled" : "disabled" });`),
    translated: statement(
      `return t("integrationState", { state: on ? t("enabled") : t("disabled") });`,
    ),
  },
  {
    shape: "a label map",
    literal: statement(`const STATUS_LABELS = { active: "Active", banned: "Banned" };`),
    translated: statement(`const STATUS_LABELS = { active: t("active"), banned: t("banned") };`),
  },
  {
    shape: "a copy key in an object",
    literal: statement(`return { id: "smtp", title: "Email delivery" };`),
    translated: statement(`return { id: "smtp", title: t("emailDelivery") };`),
  },
  {
    shape: "page metadata",
    literal: `export const metadata = { title: "Bulk Configure" };\n`,
    translated: `export const metadata = { title: titleFor("bulkConfigure") };\n`,
  },
];

describe("noLiteralCopy", () => {
  it.each(shapes)("reports $shape and accepts the translated form", ({ literal, translated }) => {
    expect(reportedLines(literal)).not.toEqual([]);
    expect(reportedLines(translated)).toEqual([]);
  });

  it("accepts separators, code, keys and props that carry no copy", () => {
    expect(
      reportedLines(`export const A = ({ t, x, on, showToast }: Props) => (
  <div>
    <TextField label={t("reason")} variant="outlined" color="primary" />
    <Chip label="·" title={name} labelId="region-label" aria-labelledby={\`tab-\${x}\`} />
    <Chip label={\`v\${x.version}\`} secondary={\`\${x.state} · \${x.dueAt}\`} />
    <Box sx={{ textAlign: "center", textTransform: "none" }} />
    {x.join(", ") || "—"}
    {on ? t(on === "update" ? "update" : "install") : null}
    {css\`color: red\`}
    {showToast(t("saved"), "success")}
  </div>
);
const titleColors = { active: "#00ff00" };
const AdminNavigationContext = createContext({ role: "admin" });
`),
    ).toEqual([]);
  });

  it("accepts the listed strings that read the same in every language", () => {
    expect(
      reportedLines(`export const A = ({ t, x }: Props) => (
  <div>
    <Typography title="OpenMapX">{"OpenMapX"}</Typography>
    {t.rich("setSecretsKey", { variable: "OPENMAPX_SECRETS_KEY", code: (chunks) => <code>{chunks}</code> })}
    <Chip label={"OPENMAPX_SECRETS_KEY"} />
    <code>{"openssl rand -hex 32"}</code>
    <TextField placeholder="https://example.com/feed.gtfs.zip" helperText={x ?? "CC-BY-4.0"} />
    {x.protocol ?? "tcp"}
  </div>
);
`),
    ).toEqual([]);
  });

  it("still reports copy that merely contains a listed string", () => {
    expect(
      reportedLines(`export const A = () => (
  <div>
    {"Run openssl rand -hex 32"}
  </div>
);
`),
    ).toEqual([3]);
  });
});
