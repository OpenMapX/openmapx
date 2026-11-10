// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are source text
import { describe, expect, it } from "vitest";
import { findUnsafeInterpolations, hasHtmlSink, type ModuleHost } from "./popup-html-guard";

const IMPORT = 'import { escapeHtml, sanitizeUrl } from "@openmapx/core";\n';

function offenders(source: string, host?: ModuleHost): string[] {
  return findUnsafeInterpolations(`${IMPORT}${source}`, "popup.tsx", { host }).map(
    (offender) => offender.text,
  );
}

describe("popup HTML guard", () => {
  describe("flags values that reach markup unescaped", () => {
    it("a label that falls back to the raw feed value", () => {
      expect(
        offenders(`
const LABELS: Record<string, string> = { downhill: "Downhill" };
export function popup(props: Record<string, string>) {
  const type = String(props.pisteType || "");
  const typeLabel = LABELS[type] || type;
  return \`<span>\${typeLabel}</span>\`;
}`),
      ).toEqual(["typeLabel"]);
    });

    it("a feature property interpolated directly", () => {
      expect(
        offenders(`export const popup = (p: Record<string, string>) => \`<b>\${p.name}</b>\`;`),
      ).toEqual(["p.name"]);
    });

    it("a value converted with String", () => {
      expect(offenders("export const popup = (p: unknown) => `<b>${String(p)}</b>`;")).toEqual([
        "String(p)",
      ]);
    });

    it("a value that was escaped in a different function", () => {
      expect(
        offenders(`
export function first(p: Record<string, string>) {
  const name = escapeHtml(p.name);
  return \`<b>\${name}</b>\`;
}
export function second(p: Record<string, string>) {
  const name = p.name;
  return \`<i>\${name}</i>\`;
}`),
      ).toEqual(["name"]);
    });

    it("a string built up over several statements", () => {
      expect(
        offenders(`
export function popup(p: Record<string, string>) {
  let details = "";
  details += \`Ref: \${escapeHtml(p.ref)}\`;
  details += \` \${p.grooming}\`;
  return \`<div>\${details}</div>\`;
}`),
      ).toEqual(["details"]);
    });

    it("an item of a mapped list", () => {
      expect(
        offenders(`
export const popup = (items: string[]) =>
  \`<ul>\${items.map((item) => \`<li>\${item}</li>\`).join("")}</ul>\`;`),
      ).toEqual(["item"]);
    });

    it("operands joined to markup with +", () => {
      expect(
        offenders(`export const popup = (p: Record<string, string>) => "<b>" + p.name + "</b>";`),
      ).toEqual(["p.name"]);
    });

    it("an exported helper that interpolates its parameters", () => {
      expect(
        offenders(`export const row = (label: string) => \`<div>\${label}</div>\`;
export const popup = () => row("Fixed");`),
      ).toEqual(["label"]);
    });

    it("a private helper called with an unescaped value", () => {
      expect(
        offenders(`
const row = (label: string) => \`<div>\${label}</div>\`;
export const popup = (p: Record<string, string>) => row(p.name);`),
      ).toEqual(["label"]);
    });

    it("a helper that is also passed around as a value", () => {
      expect(
        offenders(`
const row = (label: string) => \`<div>\${label}</div>\`;
export const popup = (names: string[]) => names.map(row).join("");
export const other = () => row("x");`),
      ).toEqual(["label"]);
    });

    it("a raw value handed straight to setHTML", () => {
      expect(
        offenders(
          `export const open = (popup: Popup, p: Record<string, string>) => popup.setHTML(p.description);`,
        ),
      ).toEqual(["p.description"]);
    });

    it("a raw value assigned to innerHTML or outerHTML", () => {
      expect(
        offenders(`
export function show(el: HTMLElement, p: Record<string, string>) {
  el.innerHTML = p.html;
  el.outerHTML = \`<p>\${p.text}</p>\`;
}`),
      ).toEqual(["p.html", "p.text"]);
    });

    it("a raw value appended to innerHTML or outerHTML", () => {
      expect(
        offenders(`
export function show(el: HTMLElement, p: Record<string, string>) {
  el.innerHTML += p.html;
  el.outerHTML += \`<p>\${p.text}</p>\`;
}`),
      ).toEqual(["p.html", "p.text"]);
    });

    it("a raw value passed to insertAdjacentHTML or createContextualFragment", () => {
      expect(
        offenders(`
export function show(el: HTMLElement, p: Record<string, string>) {
  el.insertAdjacentHTML("beforeend", p.html);
  document.createRange().createContextualFragment(p.fragment);
}`),
      ).toEqual(["p.html", "p.fragment"]);
    });

    it("a raw value in dangerouslySetInnerHTML", () => {
      expect(
        offenders(
          `export const View = (p: Record<string, string>) => <div dangerouslySetInnerHTML={{ __html: p.html }} />;`,
        ),
      ).toEqual(["p.html"]);
    });

    it("a file that imports escapeHtml but does not use it on the value", () => {
      expect(
        offenders(`export const popup = (p: Record<string, string>) => \`<b>\${p.name}</b>\`;`),
      ).toEqual(["p.name"]);
    });

    it("a helper imported under another helper's name", () => {
      const source = `
import { raw as escapeHtml } from "./raw";
export const popup = (p: Record<string, string>) => \`<b>\${escapeHtml(p.name)}</b>\`;`;
      expect(findUnsafeInterpolations(source, "popup.tsx").map((o) => o.text)).toEqual([
        "escapeHtml(p.name)",
      ]);
    });

    it("a local value that shadows a helper's name", () => {
      expect(
        offenders(`
export function popup(p: Record<string, string>) {
  const sanitizeUrl = (value: string) => value;
  const escape = sanitizeUrl;
  return \`<a href="\${sanitizeUrl(p.url)}">\${escape(p.name)}</a>\`;
}`),
      ).toEqual(["sanitizeUrl(p.url)", "escape(p.name)"]);
    });

    it("a translation that interpolates values into its message", () => {
      expect(
        offenders(`
export function popup(p: Record<string, string>, t: (k: string, v?: object) => string) {
  return \`<b>\${t("greeting", { name: p.name })}</b>\`;
}`),
      ).toEqual(['t("greeting", { name: p.name })']);
      expect(
        offenders(
          `export const popup = (p: string) => \`<b>\${translate("greeting", { n: p })}</b>\`;`,
        ),
      ).toEqual(['translate("greeting", { n: p })']);
    });

    it("a locale formatter applied to a raw string", () => {
      expect(
        offenders(
          `export const popup = (p: Record<string, string>) => \`<b>\${p.when.toLocaleString()}</b>\`;`,
        ),
      ).toEqual(["p.when.toLocaleString()"]);
    });
  });

  describe("accepts values that cannot carry markup", () => {
    it.each([
      ["an escaped value", "`<b>${escapeHtml(p.name)}</b>`"],
      [
        "a binding to an escaped value",
        "(() => { const n = escapeHtml(p.name); return `<b>${n}</b>`; })()",
      ],
      ["a number formatter", "`<b>${Number(p.v).toFixed(1)}</b>`"],
      ["a count", "`<b>${items.length}</b>`"],
      ["a literal fallback", '`<b>${escapeHtml(p.name) || "Unnamed"}</b>`'],
      ["a comparison", "`<b>${p.a === p.b}</b>`"],
      ["a URL checked by sanitizeUrl", '`<a href="${sanitizeUrl(p.url)}">x</a>`'],
      ["a translated label", "`<b>${t(p.key)}</b>`"],
      ["a translation without values", '`<b>${translate("greeting")}</b>`'],
      ["a date formatted for the locale", "`<b>${new Date(p.when).toLocaleString()}</b>`"],
      ["a lookup in a constant table", '`<b style="color:${COLORS[p.level] || "#888"}">x</b>`'],
      ["an escaped list", '`<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`'],
      ["a mapped escape", '`<b>${items.map(escapeHtml).join(", ")}</b>`'],
    ])("%s", (_name, expression) => {
      const source = `
const COLORS = { low: "#0f0", high: "#f00" };
export function popup(p: Record<string, string>, items: string[], t: (k: string) => string) {
  return ${expression};
}`;
      expect(offenders(source)).toEqual([]);
    });

    it("a private helper that is only called with safe values", () => {
      expect(
        offenders(`
const row = (label: string, value: string) => \`<div>\${label}: \${value}</div>\`;
export const popup = (p: Record<string, string>) =>
  row("Name", escapeHtml(p.name)) + row("Count", String(p.count).length ? "many" : "none");`),
      ).toEqual([]);
    });

    it("a number-typed parameter", () => {
      expect(offenders(`export const badge = (count: number) => \`<b>\${count}</b>\`;`)).toEqual(
        [],
      );
    });

    it("a loop over a constant table", () => {
      expect(
        offenders(`
const STEPS = [[0, "#0f0"], [5, "#f00"]];
export function color(level: number) {
  let color = STEPS[0][1];
  for (const [limit, c] of STEPS) if (level >= limit) color = c;
  return \`<b style="color:\${color}">x</b>\`;
}`),
      ).toEqual([]);
    });

    it("the content a trusted builder returned, handed to setHTML", () => {
      expect(
        offenders(`
export function open(popup: Popup) {
  const content = buildPopupCard(spec, props);
  popup.setHTML(content);
  popup.setHTML(buildPopupCard(spec, props));
}`),
      ).toEqual([]);
    });

    it("ignores strings that are not markup", () => {
      expect(
        offenders("export const url = (p: Record<string, string>) => `${p.base}/a?b=${p.c}`;"),
      ).toEqual([]);
    });

    it("a constant table declared in an imported module", () => {
      const host: ModuleHost = {
        read: (_from, specifier) =>
          specifier === "./colors"
            ? { fileName: "colors.ts", source: 'export const COLORS = { low: "#0f0" };' }
            : undefined,
      };
      const source = `
import { COLORS } from "./colors";
export const popup = (level: string) => \`<b style="color:\${COLORS[level] || "#888"}">x</b>\`;`;
      expect(offenders(source, host)).toEqual([]);
      expect(offenders(source)).toEqual(["COLORS[level]"]);
    });

    it("an imported value that is not a constant table", () => {
      const host: ModuleHost = {
        read: () => ({ fileName: "label.ts", source: "export const label = readLabel();" }),
      };
      expect(
        offenders(
          `import { label } from "./label";\nexport const popup = () => \`<b>\${label}</b>\`;`,
          host,
        ),
      ).toEqual(["label"]);
    });
  });

  describe("recognises HTML sinks", () => {
    it.each([
      "popup.setHTML(html)",
      "el.innerHTML = html",
      "el.innerHTML += html",
      "el.outerHTML+=html",
      "el.outerHTML = html",
      "el.insertAdjacentHTML('beforeend', html)",
      "range.createContextualFragment(html)",
      "<div dangerouslySetInnerHTML={{ __html: html }} />",
    ])("%s", (sink) => {
      expect(hasHtmlSink(sink)).toBe(true);
    });

    it("does not treat reads or text content as sinks", () => {
      expect(hasHtmlSink("const text = el.innerHTML.length; el.textContent = x;")).toBe(false);
      expect(hasHtmlSink("if (el.innerHTML === html || el.innerHTML == html) return;")).toBe(false);
    });
  });
});
