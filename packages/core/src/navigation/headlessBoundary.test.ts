import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/** Paths that must never appear in the curated subpath's dependency graph. */
const FORBIDDEN = [
  /(^|\/)react(?:-dom)?\//,
  /zustand/,
  /better-auth/,
  /@tanstack\/react-query/,
  /next-intl/,
  /packages\/core\/src\/stores\//,
  /packages\/core\/src\/hooks\//,
  /packages\/core\/src\/platform\/storage/,
  /apps\/web\//,
];

/** Browser globals a headless bundle must not touch. */
const DOM_GLOBALS = [
  /\bwindow\./,
  /\bdocument\./,
  /\bnavigator\./,
  /\blocalStorage\b/,
  /\bindexedDB\b/,
];

async function bundleNavigationBarrel(
  entryContents: string,
  // `neutral` is the real assertion: it proves the graph needs neither browser
  // nor node export conditions. The control case uses `node` only so that bare
  // specifiers the root barrel drags in can resolve at all.
  platform: "neutral" | "node" = "neutral",
) {
  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: import.meta.dirname,
      sourcefile: "headless-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    platform,
    format: "esm",
    logLevel: "silent",
  });
  return {
    inputs: Object.keys(result.metafile.inputs).map((path) => path.replace(/\\/g, "/")),
    code: result.outputFiles.map((file) => file.text).join("\n"),
  };
}

describe("dependency graph", () => {
  it("bundles the headless navigation graph without browser dependencies or DOM globals", async () => {
    const { inputs, code } = await bundleNavigationBarrel(
      `import * as navigation from "./index";\nexport default navigation;`,
    );
    const offenders = inputs.filter((input) => FORBIDDEN.some((pattern) => pattern.test(input)));
    expect(offenders).toEqual([]);
    expect(inputs.some((input) => input.endsWith("packages/core/src/navigation/index.ts"))).toBe(
      true,
    );
    for (const pattern of DOM_GLOBALS) expect(code).not.toMatch(pattern);
  });

  it("would catch a forbidden import, proving the check has teeth", async () => {
    // The root barrel deliberately pulls React, Zustand and auth. If importing
    // it produced a clean graph, the assertion above would be meaningless.
    const { inputs } = await bundleNavigationBarrel(
      `import * as core from "../index";\nexport default core;`,
      "node",
    );
    const offenders = inputs.filter((input) => FORBIDDEN.some((pattern) => pattern.test(input)));
    expect(offenders.length).toBeGreaterThan(0);
  });
});
