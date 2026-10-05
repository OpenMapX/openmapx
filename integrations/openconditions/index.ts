/**
 * OpenConditions, built in: reads the OpenConditions HTTP API at
 * `OPENCONDITIONS_URL` and registers its road-conditions, fuel-stations and
 * parking-sites providers. The OpenConditions services themselves run beside OpenMapX; no
 * OpenConditions code runs here.
 *
 * The data sources are the instance's own: the integration reads its
 * `/sources` list at setup and every five minutes after, and supplies it with
 * `ctx.setDataSources` (the manifest sets `runtimeDataSources`). Setup waits
 * up to three seconds for the first list so credits and legal pages are
 * complete as soon as the providers serve. The providers fail closed: until
 * the first list arrives nothing can be credited or gated by the data-use
 * policy, so they serve nothing (a routing read rejects, as in an outage);
 * after it, they serve only the records of the sources the host accepted.
 * A list served in the public scope leaves out the restricted sources, whose
 * records that scope never serves.
 *
 * Egress target: `OPENCONDITIONS_URL` (operator-configured, never
 * user-supplied). With `OPENCONDITIONS_OPERATOR_TOKEN` set, every read sends
 * it as a bearer token and OpenConditions answers in operator scope.
 * Without `OPENCONDITIONS_URL` the integration registers nothing.
 */
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createOpenConditionsClient } from "./client.js";
import { createFuelStationProvider } from "./fuel/provider.js";
import { createParkingSiteProvider } from "./parking/provider.js";
import { createRoadConditionsProvider } from "./road-conditions/provider.js";
import { createLiveSources, startSourceSync } from "./sources.js";

/** How long setup waits for the first `/sources` list before registering the providers. */
const FIRST_SOURCES_WAIT_MS = 3_000;

export async function setup(
  ctx: IntegrationContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const client = createOpenConditionsClient(env, ctx.http);
  if (!client) return;

  const sources = createLiveSources();
  const sync = startSourceSync(ctx, client, { onSources: (list) => sources.update(list) });
  let waited: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    sync.first,
    new Promise<void>((resolve) => {
      waited = setTimeout(resolve, FIRST_SOURCES_WAIT_MS);
      waited.unref?.();
    }),
  ]);
  clearTimeout(waited);

  ctx.registerRoadConditionsProvider(createRoadConditionsProvider(client, sources));
  ctx.registerFuelStationProvider(createFuelStationProvider(client, sources));
  ctx.registerParkingSiteProvider(createParkingSiteProvider(client, sources));
}
