import { describe, expect, it } from "vitest";
import {
  analyzeBackgroundBundle,
  FORBIDDEN_BACKGROUND_MODULES,
  resolvedVersionsOf,
} from "./backgroundBundlePolicy";

const HEALTHY_SOURCES = [
  "__prelude__",
  "/node_modules/.pnpm/react@19.2.3/node_modules/react/index.js",
  "/node_modules/.pnpm/react-native@0.86.0_abc/node_modules/react-native/index.js",
  "/node_modules/.pnpm/expo-task-manager@57.0.8_x/node_modules/expo-task-manager/build/TaskManager.js",
  "/node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js",
  "/apps/mobile/src/background/defineNavigationTask.ts",
  "/packages/core/src/navigation/processFix.ts",
];

function analyze(sources: string[] = HEALTHY_SOURCES, code = "// bundle") {
  return analyzeBackgroundBundle({ sources, code, byteLength: code.length });
}

describe("analyzeBackgroundBundle", () => {
  it("accepts a headless-safe graph", () => {
    expect(analyze().failures).toEqual([]);
  });

  it("reports the module count and bundle size for the runbook baseline", () => {
    const report = analyze(HEALTHY_SOURCES, "x".repeat(2048));
    expect(report.moduleCount).toBe(HEALTHY_SOURCES.length);
    expect(report.byteLength).toBe(2048);
  });

  it("lists only workspace-owned modules", () => {
    expect(analyze().workspaceModules).toEqual([
      "/apps/mobile/src/background/defineNavigationTask.ts",
      "/packages/core/src/navigation/processFix.ts",
    ]);
  });
});

describe("forbidden dependencies", () => {
  it.each([
    ["/node_modules/.pnpm/react-dom@19.2.3/node_modules/react-dom/index.js", "react-dom"],
    ["/node_modules/.pnpm/zustand@5.0.14/node_modules/zustand/index.js", "zustand"],
    ["/node_modules/.pnpm/better-auth@1.6.26/node_modules/better-auth/index.js", "better-auth"],
    [
      "/node_modules/.pnpm/@tanstack+react-query@5.1.0/node_modules/@tanstack/react-query/index.js",
      "@tanstack/react-query",
    ],
    ["/node_modules/.pnpm/next-intl@4.0.0/node_modules/next-intl/index.js", "next-intl"],
    [
      "/node_modules/.pnpm/maplibre-gl@5.0.0/node_modules/maplibre-gl/dist/maplibre-gl.js",
      "maplibre-gl",
    ],
    [
      "/node_modules/.pnpm/@mui+material@7.0.0/node_modules/@mui/material/index.js",
      "@mui/material",
    ],
    ["/packages/core/src/stores/navigationStore.ts", "a Zustand store"],
    ["/packages/core/src/hooks/transit/useTransitPlan.ts", "a React hook"],
    ["/packages/core/src/platform/storage/indexedDb.ts", "browser storage"],
    ["/apps/web/src/lib/navigation/useNavigationEngine.ts", "the web app"],
  ])("rejects %s (%s)", (offender) => {
    const report = analyze([...HEALTHY_SOURCES, offender]);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.join("\n")).toContain(offender);
  });

  it("explains why each forbidden module is forbidden", () => {
    const report = analyze([
      ...HEALTHY_SOURCES,
      "/node_modules/.pnpm/zustand@5.0.14/node_modules/zustand/index.js",
    ]);
    expect(report.failures[0]).toContain("browser store state is not the background authority");
  });

  it("keeps a reason for every rule", () => {
    for (const rule of FORBIDDEN_BACKGROUND_MODULES) {
      expect(rule.reason.length).toBeGreaterThan(10);
    }
  });

  it("does not confuse react-native with react-dom", () => {
    expect(analyze().failures).toEqual([]);
  });
});

describe("duplicate runtimes", () => {
  it("rejects two React runtimes", () => {
    const report = analyze([
      ...HEALTHY_SOURCES,
      "/node_modules/.pnpm/react@19.2.8/node_modules/react/index.js",
    ]);
    expect(report.failures.join("\n")).toMatch(/2 React runtimes/);
    expect(report.reactRuntimeVersions).toEqual(["19.2.3", "19.2.8"]);
  });

  it.each(["react-native", "expo-modules-core", "zod"])("rejects two copies of %s", (name) => {
    const report = analyze([
      ...HEALTHY_SOURCES,
      `/node_modules/.pnpm/${name}@9.9.9/node_modules/${name}/index.js`,
      `/node_modules/.pnpm/${name}@8.8.8/node_modules/${name}/index.js`,
    ]);
    expect(report.failures.join("\n")).toContain(`copies of ${name}`);
  });

  it("accepts one copy resolved through several peer hashes", () => {
    const report = analyze([
      ...HEALTHY_SOURCES,
      "/node_modules/.pnpm/react-native@0.86.0_def/node_modules/react-native/Libraries/Core.js",
    ]);
    expect(report.failures).toEqual([]);
  });
});

describe("resolvedVersionsOf", () => {
  it("reads the version out of a pnpm store path", () => {
    expect(resolvedVersionsOf(HEALTHY_SOURCES, "react")).toEqual(["19.2.3"]);
  });

  it("ignores a package that is not present", () => {
    expect(resolvedVersionsOf(HEALTHY_SOURCES, "lodash")).toEqual([]);
  });

  it("does not match a package whose name is a prefix of another", () => {
    expect(resolvedVersionsOf(HEALTHY_SOURCES, "react-nat")).toEqual([]);
  });
});
