import { AMBIENT_MAX_AGE_MS, type AmbientManifest } from "@openmapx/core/ambient-places";
import { useEffect, useState } from "react";

const REFRESH_MS = 60_000;

function usable(manifest: AmbientManifest | null): manifest is AmbientManifest {
  return Boolean(
    manifest?.enabled &&
      [
        manifest.publishedAt,
        manifest.sources.osm.publishedAt,
        ...(manifest.sources.overture ? [manifest.sources.overture.publishedAt] : []),
      ].every(
        (date) =>
          Number.isFinite(Date.parse(date)) && Date.now() - Date.parse(date) <= AMBIENT_MAX_AGE_MS,
      ),
  );
}

interface Discovery {
  apiUrl: string;
  manifest: AmbientManifest | null;
}

/**
 * Discovers the regional publication served by one API origin. The result is
 * owned by the calling component and that origin: it is `null` unless the
 * publication is enabled and fresh, and a failed refresh keeps only a fresh
 * generation already discovered from the same API origin by this mounted component.
 */
export function useAmbientPublication(apiUrl: string): AmbientManifest | null {
  const [discovery, setDiscovery] = useState<Discovery>({ apiUrl, manifest: null });

  useEffect(() => {
    let current = true;
    let controller: AbortController | null = null;
    // Re-evaluate what is held before each request: a different origin's
    // generation, or one that has aged out, must not outlive a hanging refresh.
    const retained = (previous: Discovery): Discovery =>
      previous.apiUrl === apiUrl && (previous.manifest === null || usable(previous.manifest))
        ? previous
        : { apiUrl, manifest: null };
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setDiscovery(retained);
      try {
        // Raw fetch: discovery must bypass HTTP caching, which fetchJson cannot express, and the
        // request is bounded by this effect: unmount, an API-origin change and each 60 s refresh abort it.
        const response = await fetch(`${apiUrl}/api/ambient-places/manifest`, {
          signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Publication unavailable");
        const body = (await response.json()) as { manifest: AmbientManifest | null };
        if (
          body.manifest &&
          (![1, 2].includes(body.manifest.version) ||
            !body.manifest.generation ||
            !body.manifest.region?.bounds ||
            !body.manifest.sources?.osm)
        )
          throw new Error("Unsupported publication");
        if (current && !signal.aborted) setDiscovery({ apiUrl, manifest: body.manifest });
      } catch {
        if (current && !signal.aborted) setDiscovery(retained);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      current = false;
      controller?.abort();
      clearInterval(timer);
    };
  }, [apiUrl]);

  return discovery.apiUrl === apiUrl && usable(discovery.manifest) ? discovery.manifest : null;
}
