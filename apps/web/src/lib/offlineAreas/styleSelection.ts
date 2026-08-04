import type { OfflineMapPackageManifest } from "@openmapx/core";
import { resolveOfflinePackageStyle } from "./packageStyle";

const ONLINE_STYLE_PROBE_TIMEOUT_MS = 3_000;

type OpenMapXStyle = Record<string, unknown> & {
  sources?: Record<string, { url?: unknown }>;
};

export type ViewportStyle = {
  offline: boolean;
  style: Record<string, unknown>;
};

type PackageStyleInput = {
  packageId: string;
  manifest: OfflineMapPackageManifest;
};

type ProbeFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function markedReachabilityUrl(sourceUrl: string): string {
  const base = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const url = new URL(sourceUrl, base);
  url.searchParams.set("openmapxReachability", "1");
  return url.toString();
}

/** Probe the exact configured vector source without accepting a service-worker cache hit. */
export async function isConfiguredOnlineStyleReachable(
  configuredStyle: Record<string, unknown>,
  options: { fetcher?: ProbeFetcher; timeoutMs?: number } = {},
): Promise<boolean> {
  const sourceUrl = (configuredStyle as OpenMapXStyle).sources?.openmaptiles?.url;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("online map source reachability probe timed out")),
    options.timeoutMs ?? ONLINE_STYLE_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetcher ?? fetch)(markedReachabilityUrl(sourceUrl), {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Preserve the configured online style whenever it is usable. Installed
 * packages are selected only for an explicit offline state or a failed source
 * probe, and contain no alternate style/layer definitions of their own.
 */
export async function selectOnlineFirstOpenMapXStyle(
  configuredStyle: Record<string, unknown>,
  packages: readonly PackageStyleInput[],
  options: {
    online?: boolean;
    probe?: (configuredStyle: Record<string, unknown>) => Promise<boolean>;
  } = {},
): Promise<ViewportStyle> {
  if (packages.length === 0) return { offline: false, style: configuredStyle };

  const online =
    options.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  if (online) {
    const reachable = await (options.probe ?? isConfiguredOnlineStyleReachable)(configuredStyle);
    if (reachable) return { offline: false, style: configuredStyle };
  }

  return {
    offline: true,
    style: resolveOfflinePackageStyle(configuredStyle, packages),
  };
}
