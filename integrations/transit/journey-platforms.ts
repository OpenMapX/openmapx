import type { RealtimeProvider } from "@openmapx/integration-framework";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { selectStopPlatform } from "@openmapx/mobility-core/platform";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { VehicleJourney } from "@openmapx/mobility-core/transit";
import type { EnrichDeps } from "./realtime";

/** Called after the baseline route cache, never cache the policy-dependent enriched response. */
export async function enrichJourneyPlatforms(
  deps: EnrichDeps & { healthy?: (id: string) => Promise<boolean> },
  base: MobilityResult<VehicleJourney | null>,
): Promise<MobilityResult<VehicleJourney | null>> {
  const baseline = base.data;
  if (!baseline) return base;
  const candidates = deps.ctx
    .getIntegrationsByDomain("live-transit")
    .flatMap((integration) =>
      ((integration.providers.get("live-transit") ?? []) as RealtimeProvider[]).map((provider) => ({
        provider,
        sources: integration.manifest.dataSources ?? [],
      })),
    )
    .filter(
      ({ provider }) => provider.capabilities.journeyPlatforms && provider.getJourneyPlatforms,
    )
    .sort((a, b) => a.provider.priority - b.provider.priority);
  const allowed = async (sources: readonly { sourceId: string }[]) => {
    const banned = await deps.ctx.getDisallowedSourceIds?.();
    return !sources.some((s) => banned?.has(s.sourceId));
  };
  for (const { provider, sources } of candidates) {
    if (!(await allowed(sources)) || (deps.healthy && !(await deps.healthy(provider.id)))) continue;
    const bbox = "bbox" in provider.coverage ? provider.coverage.bbox : undefined;
    if (
      bbox &&
      !baseline.stops.some(
        (s) => s.lng >= bbox[0] && s.lng <= bbox[2] && s.lat >= bbox[1] && s.lat <= bbox[3],
      )
    )
      continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await deps.timed(provider.id, "getJourneyPlatforms", () =>
        Promise.race([
          provider.getJourneyPlatforms?.(baseline) ??
            Promise.reject(new Error("Missing platform provider")),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Platform evidence deadline")), 750);
          }),
        ]),
      );
      if (!outcome.ok || !outcome.value.data.length || !(await allowed(sources))) continue;
      const updates = outcome.value.data;
      if (
        new Set(updates.map((u) => u.stopIndex)).size !== updates.length ||
        updates.some(
          (u) =>
            !Number.isInteger(u.stopIndex) ||
            u.stopIndex < 0 ||
            u.stopIndex >= baseline.stops.length,
        )
      )
        continue;
      const data = { ...baseline, stops: baseline.stops.map((s) => ({ ...s })) };
      let applied = false;
      for (const update of updates) {
        const stop = data.stops[update.stopIndex];
        if (stop.canceled) continue;
        for (const event of ["arrivalPlatform", "departurePlatform"] as const) {
          const evidence = update[event];
          if (
            !evidence?.code ||
            evidence.code.length > 64 ||
            !sources.some((s) => s.sourceId === evidence.sourceId)
          )
            continue;
          stop[event] = { ...evidence };
          stop.fieldContributors = {
            ...stop.fieldContributors,
            [event]: snapshotContributors(outcome.value.attributions),
          };
          applied = true;
        }
        if (!stop.arrivalPlatform && !stop.departurePlatform) continue;
        const effective = selectStopPlatform(
          stop,
          stop.departurePlatform ? "departure" : "arrival",
        );
        stop.platform = effective.code;
        stop.scheduledPlatform = effective.scheduledCode;
        const field = stop.departurePlatform ? "departurePlatform" : "arrivalPlatform";
        stop.fieldContributors = {
          ...stop.fieldContributors,
          platform: stop.fieldContributors?.[field] ?? [],
          scheduledPlatform: stop.fieldContributors?.[field] ?? [],
        };
        stop.contributors = snapshotContributors(
          stop.contributors ?? base.attributions,
          outcome.value.attributions,
        );
      }
      if (applied && (await allowed(sources)))
        return {
          ...base,
          data,
          attributions: snapshotContributors(base.attributions, outcome.value.attributions),
        };
    } catch {
      /* A platform source must not make a usable baseline journey unavailable. */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return base;
}
