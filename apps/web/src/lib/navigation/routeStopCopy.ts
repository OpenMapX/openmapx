import type { AlongRoutePoi, CategoryPlace } from "@openmapx/core";

/** Shared confidence copy for map labels and the selected card. */
export function routeStopCopy(poi: AlongRoutePoi<CategoryPlace>, compact = false) {
  const kind = poi.detour?.kind;
  const minutes = Math.max(
    0,
    Math.ceil((poi.detour?.kind === "network" ? poi.detour.seconds : poi.detourSeconds) / 60),
  );
  if (kind === "network")
    return { key: compact ? "rsPinNetwork" : "rsDetourNetwork", values: { minutes } } as const;
  if (kind === "unreachable")
    return { key: compact ? "rsPinUnreachable" : "rsDetourUnreachable" } as const;
  if (kind === "unknown") return { key: compact ? "rsPinUnknown" : "rsDetourUnknown" } as const;
  if (poi.detourPending) return { key: compact ? "rsPinChecking" : "rsDetourChecking" } as const;
  return {
    key: compact ? "rsPinApproximate" : "rsDetourApproximate",
    values: { minutes },
  } as const;
}
