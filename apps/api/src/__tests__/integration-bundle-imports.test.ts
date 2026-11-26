import { describe, expect, it } from "vitest";
import { assertBundleImports } from "../integration-bundle-imports";

const bundle = (source: string): Uint8Array => Buffer.from(source, "utf8");

const HOST_ALIAS = "@integrations/x";
const HOST_SOURCE = "file:///app/packages/place-ids/src/index.ts";

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

/**
 * Characters ECMAScript counts as whitespace or line terminators beyond the
 * ASCII ones; Node skips them like any other, so an import behind them runs.
 */
const UNICODE_SEPARATORS = [
  ["U+FEFF", String.fromCodePoint(0xfeff)],
  ["U+2028", LINE_SEPARATOR],
  ["U+2029", String.fromCodePoint(0x2029)],
  ["U+2002", String.fromCodePoint(0x2002)],
  ["U+3000", IDEOGRAPHIC_SPACE],
] as const;

/** The same source behind separators only the language's own rules recognise. */
const hidden = (source: string) =>
  `const a = 1;${LINE_SEPARATOR}${source.replaceAll("import(", `import(${IDEOGRAPHIC_SPACE}`)}`;

/** Generated module code of roughly the given size in bytes. */
function largeBundle(bytes: number): string {
  const chunk = (n: number) => `
export class Store${n} extends Map {
  #hits = 0;
  static label = \`store-\${${n}}\`;
  get(key) { this.#hits += 1; return super.get(key) ?? this.#fallback?.(key); }
  #fallback = (key) => ({ key, at: Date.now(), tags: [...String(key).matchAll(/[a-z]+/giu)].map((m) => m[0]) });
}
const parse${n} = async (input, { strict = false, ...rest } = {}) => {
  const text = "import(\\"not-an-import\\") // import 'nothing'";
  for (const [index, value] of Object.entries(rest)) {
    if (strict && typeof value !== "string") throw new TypeError(\`bad \${index}: \${text}\`);
  }
  return input?.split?.(",").filter(Boolean).map((part) => part.trim()) ?? [];
};
export function run${n}(items) {
  let total = 0n;
  for (const item of items) total += BigInt(item.length ?? 0);
  return { total, parsed: parse${n}(items.join(",")), store: new Store${n}() };
}
`;
  const head = 'import { z } from "zod";\n';
  const parts = [head];
  let length = head.length;
  for (let n = 0; length < bytes; n += 1) {
    const part = chunk(n);
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}

describe("installed backend bundle imports", () => {
  it.each([
    'import { createPlace } from "@openmapx/integration-sdk/places";',
    'import * as sdk from "@openmapx/integration-sdk";',
    'export { httpError } from "@openmapx/integration-sdk/errors";',
    'import { z } from "zod";',
    'import { z } from "zod/v4";',
    'import { createHash } from "node:crypto";',
    'import { readFile } from "fs/promises";',
    'const http = await import("node:http");',
    "const url = import.meta.url;",
    // Not a literal: cannot be checked without running the code.
    "const name = 'x'; await import(name);",
    // Specifiers inside strings and comments are not imports.
    'const text = "import(\\"fastify\\")"; // import "fastify"',
    // A line separator inside a string literal is part of the string.
    `const text = "a${LINE_SEPARATOR}import \\"fastify\\""; import "zod";`,
    '#!/usr/bin/env node\nimport { z } from "zod";',
    'import data from "zod/package.json" with { type: "json" }; export * as v4 from "zod/v4";',
    "class A { #p = 1; static s = 2; static { this.t = 3; } has(o) { return #p in o; } }",
    "await Promise.resolve(); { using r = { [Symbol.dispose]() {} }; }",
  ])("accepts %s", (source) => {
    expect(() => assertBundleImports(bundle(source))).not.toThrow();
  });

  it.each([
    ['import "@openmapx/integration-framework";', "@openmapx/integration-framework"],
    ['import "@openmapx/integration-sdk/not-an-entry";', "@openmapx/integration-sdk/not-an-entry"],
    [
      'import pkg from "@openmapx/integration-sdk/package.json";',
      "@openmapx/integration-sdk/package.json",
    ],
    ['import "@integrations/weather/index.ts";', "@integrations/weather/index.ts"],
    ['export * from "fastify";', "fastify"],
    ['export { a } from "./chunk.mjs";', "./chunk.mjs"],
    ['await import("pg");', "pg"],
    ['await import("file:///etc/passwd");', "file:///etc/passwd"],
    ['import "node:not-a-module";', "node:not-a-module"],
  ])("refuses %s", (source, specifier) => {
    expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(specifier));
  });

  describe("with whitespace and line terminators beyond ASCII", () => {
    it.each(
      UNICODE_SEPARATORS.flatMap(([name, character]) => [
        [`${name} at the start of the bundle`, `${character}import "${HOST_ALIAS}";`],
        [`${name} after a statement`, `const a = 1;${character}import "${HOST_ALIAS}";`],
        [`${name} after the import keyword`, `import${character}"${HOST_ALIAS}";`],
        [`${name} inside import()`, `await import(${character}"${HOST_ALIAS}");`],
        [`${name} before export * from`, `const a = 1;${character}export * from "${HOST_ALIAS}";`],
      ]),
    )("refuses an import hidden by %s", (_label, source) => {
      expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(HOST_ALIAS));
    });

    it("refuses an import after a line comment that U+2028 ends", () => {
      const source = `// note${LINE_SEPARATOR}import "${HOST_ALIAS}";`;
      expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(HOST_ALIAS));
    });

    it("refuses an import after a hashbang that U+2028 ends", () => {
      const source = `#!/usr/bin/env node${LINE_SEPARATOR}import "${HOST_ALIAS}";`;
      expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(HOST_ALIAS));
    });

    it("refuses a file: URL of host source", () => {
      const source = `${LINE_SEPARATOR}import "${HOST_SOURCE}";`;
      expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(HOST_SOURCE));
    });

    it("refuses an import behind a byte order mark", () => {
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`import "${HOST_ALIAS}";`),
      ]);
      expect(() => assertBundleImports(bytes)).toThrow(JSON.stringify(HOST_ALIAS));
    });
  });

  it.each([
    ["Unicode escapes", 'import "\\u0040integrations/x";'],
    ["hexadecimal and code point escapes", 'import "\\x40integrations\\u{2F}x";'],
    ["a line continuation", 'import "@integrations/\\\nx";'],
  ])("judges a specifier written with %s by its value", (_label, source) => {
    expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(HOST_ALIAS));
    expect(() => assertBundleImports(bundle(hidden(source)))).toThrow(JSON.stringify(HOST_ALIAS));
  });

  it.each([
    ["export * from", `export * from "${HOST_ALIAS}";`],
    ["export * as", `export * as ns from "${HOST_ALIAS}";`],
    ["a template literal in import()", `await import(\`${HOST_ALIAS}\`);`],
    ["a parenthesized literal in import()", `await import(("${HOST_ALIAS}"));`],
    [
      "an import() inside the options of another",
      `await import("zod", { with: { type: await import("${HOST_ALIAS}") } });`,
    ],
  ])("refuses %s", (_label, source) => {
    expect(() => assertBundleImports(bundle(source))).toThrow(JSON.stringify(HOST_ALIAS));
    expect(() => assertBundleImports(bundle(hidden(source)))).toThrow(JSON.stringify(HOST_ALIAS));
  });

  it.each([
    ["an unbalanced import", 'import { from "zod"'],
    ["a syntax error before an import", 'const = 1;\nimport "zod";'],
    ["a duplicate declaration", "let a = 1;\nlet a = 2;"],
    [
      "CommonJS with a top-level return",
      'const z = require("zod");\nif (!z) return;\nmodule.exports = z;',
    ],
    ["CommonJS with a sloppy-mode octal", "var mode = 0644;\nmodule.exports = { mode };"],
    ["CommonJS with a with statement", 'with (require("zod")) { module.exports = z; }'],
  ])("refuses %s as not a valid ES module", (_label, source) => {
    expect(() => assertBundleImports(bundle(source))).toThrow(
      /^backend bundle is not a valid ES module: /,
    );
  });

  it("refuses bytes that are not valid UTF-8", () => {
    const bytes = Buffer.concat([
      Buffer.from('const a = "'),
      Buffer.from([0xff]),
      Buffer.from('"; import "zod";'),
    ]);
    expect(() => assertBundleImports(bytes)).toThrow(
      "backend bundle is not a valid ES module: it is not valid UTF-8",
    );
  });

  it("scans a bundle as large as the largest backend entry", { timeout: 30_000 }, () => {
    const source = largeBundle(8 * 1024 * 1024);
    expect(() => assertBundleImports(bundle(source))).not.toThrow();
    expect(() =>
      assertBundleImports(bundle(`${source}${LINE_SEPARATOR}import "${HOST_ALIAS}";\n`)),
    ).toThrow(JSON.stringify(HOST_ALIAS));
  });
});
