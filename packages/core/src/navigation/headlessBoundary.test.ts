import {
  type FixInput,
  NAVIGATION_SESSION_MAX_AGE_MS,
  type NavTickState,
  navOptionsForMode,
  processFix,
} from "@openmapx/core/navigation";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The background TaskManager callback can be invoked by the operating system
 * with no UI at all. Anything reachable from `@openmapx/core/navigation` that
 * assumes a browser, a React tree, a store or a server runtime is a crash
 * waiting for a locked screen — so the boundary is asserted by bundling the real
 * barrel and inspecting the graph, not by convention.
 */

describe("headless navigation export", () => {
  it("exports the pure engine and its public types", () => {
    expect(typeof processFix).toBe("function");
    expect(navOptionsForMode("driving").accuracyCapMeters).toBeGreaterThan(0);
    expect(NAVIGATION_SESSION_MAX_AGE_MS).toBe(86_400_000);
    const _fix: FixInput = { coords: [8.68, 50.11], accuracy: 5, timestampMs: 1 };
    const _state: NavTickState = {
      offRouteScore: 0,
      lastRerouteAtMs: null,
      rerouteBackoffMs: 0,
      spokenCues: [],
    };
    expect(_fix.coords).toHaveLength(2);
    expect(_state.offRouteScore).toBe(0);
  });
});

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
  it("reaches no browser, React, auth or store code", async () => {
    const { inputs } = await bundleNavigationBarrel(
      `import * as navigation from "./index";\nexport default navigation;`,
    );
    const offenders = inputs.filter((input) => FORBIDDEN.some((pattern) => pattern.test(input)));
    expect(offenders).toEqual([]);
  });

  it("touches no DOM global", async () => {
    const { code } = await bundleNavigationBarrel(
      `import * as navigation from "./index";\nexport default navigation;`,
    );
    for (const pattern of DOM_GLOBALS) expect(code).not.toMatch(pattern);
  });

  it("bundles something substantial, so an empty graph cannot pass silently", async () => {
    const { inputs } = await bundleNavigationBarrel(
      `import * as navigation from "./index";\nexport default navigation;`,
    );
    expect(inputs.length).toBeGreaterThan(5);
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
