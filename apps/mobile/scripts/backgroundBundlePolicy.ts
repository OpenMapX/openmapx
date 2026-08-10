/**
 * Policy for the headless background bundle.
 *
 * The TaskManager callback can be invoked by the operating system with no UI at
 * all: no React tree, no WebView, no store, no window. Anything in its
 * dependency graph that assumes otherwise is a crash waiting for a locked
 * screen. This module turns that requirement into a check over the real Metro
 * graph rather than a convention people have to remember.
 */

export interface ForbiddenModuleRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Modules the background graph must never reach. Each carries its reason so a
 * failure explains itself rather than just naming a regex.
 */
export const FORBIDDEN_BACKGROUND_MODULES: ForbiddenModuleRule[] = [
  { pattern: /[/\\]react-dom[/\\]/, reason: "a renderer cannot exist in a headless task" },
  { pattern: /[/\\]zustand[/\\]/, reason: "browser store state is not the background authority" },
  { pattern: /[/\\]better-auth[/\\]/, reason: "authentication stays inside the WebView" },
  {
    pattern: /[/\\]@tanstack[/\\]react-query[/\\]/,
    reason: "query lifecycle needs React, which the task does not have",
  },
  {
    pattern: /[/\\]next-intl[/\\]/,
    reason: "cue formatting must not depend on a React i18n runtime",
  },
  {
    pattern: /[/\\]next[/\\]dist[/\\]/,
    reason: "the web framework has no place in the app bundle",
  },
  { pattern: /[/\\]maplibre-gl[/\\]/, reason: "map rendering belongs to the WebView" },
  { pattern: /[/\\]@mui[/\\]/, reason: "the design system belongs to the WebView" },
  {
    pattern: /packages[/\\]core[/\\]src[/\\]stores[/\\]/,
    reason: "Zustand stores are browser-only",
  },
  {
    pattern: /packages[/\\]core[/\\]src[/\\]hooks[/\\]/,
    reason: "React hooks cannot run headlessly",
  },
  {
    pattern: /packages[/\\]core[/\\]src[/\\]platform[/\\]storage/,
    reason: "browser storage is unreachable from a native task",
  },
  { pattern: /apps[/\\]web[/\\]/, reason: "the web app is not a dependency of the native shell" },
];

/** Workspace-owned paths, where a DOM reference is our bug rather than a vendor's. */
const WORKSPACE_SOURCE = /(^|\/)(apps|packages)\/[^/]+\/(src|.*\.ts)/;

export interface BundleGraphInput {
  /** `sources` from the bundle's source map. */
  sources: readonly string[];
  /** Emitted bundle text, used for the DOM-global scan. */
  code: string;
  /** Serialized bundle size in bytes. */
  byteLength: number;
}

export interface BundleGraphReport {
  moduleCount: number;
  byteLength: number;
  reactRuntimeVersions: string[];
  workspaceModules: string[];
  failures: string[];
}

/** Extracts the version of every distinct copy of a package in the graph. */
export function resolvedVersionsOf(sources: readonly string[], packageName: string): string[] {
  const escaped = packageName.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
  const pattern = new RegExp(`[/\\\\]\\.pnpm[/\\\\]${escaped}@([^_/\\\\]+)`);
  const versions = new Set<string>();
  for (const source of sources) {
    const match = source.match(pattern);
    if (match) versions.add(match[1]);
  }
  return [...versions].sort();
}

export function analyzeBackgroundBundle(input: BundleGraphInput): BundleGraphReport {
  const failures: string[] = [];

  for (const rule of FORBIDDEN_BACKGROUND_MODULES) {
    const offenders = input.sources.filter((source) => rule.pattern.test(source));
    if (offenders.length > 0) {
      failures.push(
        `${offenders.length} module(s) matching ${rule.pattern} reached the background graph — ${rule.reason} (e.g. ${offenders[0]})`,
      );
    }
  }

  // Two React copies in one bundle means two reconcilers and two hook
  // dispatchers; it breaks in ways that are extremely hard to diagnose.
  const reactRuntimeVersions = resolvedVersionsOf(input.sources, "react");
  if (reactRuntimeVersions.length > 1) {
    failures.push(
      `the bundle contains ${reactRuntimeVersions.length} React runtimes (${reactRuntimeVersions.join(", ")}); exactly one is allowed`,
    );
  }
  for (const duplicated of ["react-native", "expo-modules-core", "zod"]) {
    const versions = resolvedVersionsOf(input.sources, duplicated);
    if (versions.length > 1) {
      failures.push(
        `the bundle contains ${versions.length} copies of ${duplicated}: ${versions.join(", ")}`,
      );
    }
  }

  const workspaceModules = input.sources.filter((source) => WORKSPACE_SOURCE.test(source)).sort();

  return {
    moduleCount: input.sources.length,
    byteLength: input.byteLength,
    reactRuntimeVersions,
    workspaceModules,
    failures,
  };
}
