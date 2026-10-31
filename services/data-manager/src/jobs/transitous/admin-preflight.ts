import { createHash, randomUUID } from "node:crypto";
import { lstatSync, statfsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseCatalogPinSet } from "@openmapx/core/catalog-pins";
import type { TransitSourceRow } from "@openmapx/core/data-manager-contracts";
import { canonicalJson } from "@openmapx/core/ops";
import { runOpsOperation } from "../../ops-client.js";
import { listTransitSources, transitSourceRevision } from "../../transit-sources.js";
import { countryOfRegion, resolveTransitOverlayPath, sourceIdForFailure } from "./internal.js";
import { type MotisOperationsPolicy, transitAllowedCountries } from "./operations-profile.js";
import { runMotisPreflight } from "./preflight.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fail = (message: string, statusCode = 409) =>
  Object.assign(Error(message), { statusCode, code: "preflight_stale" });
export type TransitPreflightBinding = {
  preflightId: string;
  fingerprint: string;
  expiresAt: string;
  sourceFingerprint: string;
};
export interface TransitPreflightOptions {
  dataDir: string;
  policy: MotisOperationsPolicy;
}
export function normalizeTransitPreflightCountries(
  countries: readonly string[],
  policy: MotisOperationsPolicy,
): string[] {
  const selected = [...new Set(countries.map((c) => c.toLowerCase()))].sort();
  if (!selected.length || selected.length > 256 || selected.some((c) => !/^([a-z]{2,3})$/.test(c)))
    throw fail("Select one or more valid countries", 400);
  const allowed = new Set(transitAllowedCountries(policy));
  if (policy.profile !== "planet" && selected.some((c) => !allowed.has(c)))
    throw fail("Selected countries exceed the instance transit scope", 422);
  return selected;
}
function configuredNumber(name: string) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
export async function collectTransitPreflight(
  options: TransitPreflightOptions,
  countries: readonly string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const selected = normalizeTransitPreflightCountries(countries, options.policy);
  const catalogDir = join(options.dataDir, ".transitous-catalog"),
    overlayPath = resolveTransitOverlayPath(options.dataDir);
  const revision = transitSourceRevision({ catalogDir, overlayPath });
  const pins = await runOpsOperation({ kind: "catalogPins.inspect" });
  if (!pins.active) throw fail("Paired catalog pins are unavailable", 503);
  const generation = parseCatalogPinSet(pins.active).generationId;
  if (pins.catalogRevisionId !== generation)
    throw fail("Paired catalog revision is unavailable", 503);
  const sources: TransitSourceRow[] = [];
  for (const country of selected) {
    for (let offset = 0; ; offset += 500) {
      signal?.throwIfAborted();
      const page = listTransitSources({
        dataDir: options.dataDir,
        catalogDir,
        overlayPath,
        countries: options.policy.countries,
        query: { country, limit: 500, offset },
      });
      if (page.sourceRevision !== revision)
        throw fail("Transit sources changed; refresh preflight");
      sources.push(...page.sources.filter((s) => s.requested));
      if (offset + page.limit >= page.total) break;
    }
  }
  const resourceConfig = {
    slotMemoryGb: configuredNumber("MOTIS_SLOT_MEMORY_GB"),
    slotCpu: configuredNumber("MOTIS_SLOT_CPU"),
    fileDescriptorLimit: configuredNumber("MOTIS_FILE_DESCRIPTOR_LIMIT"),
    buildTimeoutHours: configuredNumber("MOTIS_BUILD_TIMEOUT_HOURS"),
  };
  let filesystem: ReturnType<typeof statfsSync> | undefined;
  try {
    filesystem = statfsSync(options.dataDir);
  } catch {
    /* Unknown space is zero, never a caller override. */
  }
  const capacity = {
    ...resourceConfig,
    freeDiskBytes: filesystem ? Number(filesystem.bavail) * Number(filesystem.bsize) : 0,
    ...(filesystem ? { freeInodes: Number(filesystem.ffree) } : {}),
  };
  const osmInput = options.policy.osmInput;
  let osmBytes: number | undefined;
  if (osmInput && !isAbsolute(osmInput) && !osmInput.split(/[\\/]/).includes("..")) {
    for (const dir of ["gtfs", "motis"]) {
      try {
        const stat = lstatSync(join(options.dataDir, dir, osmInput));
        if (stat.isFile()) {
          osmBytes = stat.size;
          break;
        }
      } catch {
        /* Missing input stays unavailable. */
      }
    }
  }
  const result = runMotisPreflight({
    policy: { ...options.policy, countries: selected },
    feedCount: sources.length,
    measuredCompressedBytes: sources.reduce((total, s) => total + (s.artifact?.sizeBytes ?? 0), 0),
    osmBytes,
    osmAvailable: osmBytes !== undefined,
    capacity,
    selectedFeedIds: sources.map((s) => s.id),
    selectedSources: sources.map((s) => ({
      id: sourceIdForFailure(countryOfRegion(s.region), s.name, s.region),
      artifactId: `${s.region}_${s.name}`.toLowerCase(),
      originUrl: s.originUrl,
      license: s.license,
    })),
  });
  const after = await runOpsOperation({ kind: "catalogPins.inspect" });
  if (
    after.catalogRevisionId !== generation ||
    transitSourceRevision({ catalogDir, overlayPath }) !== revision
  )
    throw fail("Transit sources or catalog pins changed; refresh preflight");
  return {
    countries: selected,
    allowedCountries: transitAllowedCountries(options.policy),
    sourceFingerprint: hash({
      countries: selected,
      generation,
      revision,
      policy: options.policy,
      resourceConfig,
    }),
    result,
  };
}
/** Preview state is bounded and advisory. Restart/expiry requires a new preview;
 * only normal durable execution admission and its live lease can authorize work. */
export function createTransitPreflightController(options: TransitPreflightOptions) {
  const previews = new Map<
    string,
    { fingerprint: string; binding: TransitPreflightBinding; countries: string[] }
  >();
  return {
    async inspect(countries: string[], signal?: AbortSignal) {
      const snapshot = await collectTransitPreflight(options, countries, signal),
        preflightId = randomUUID(),
        expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      for (const [id, preview] of previews)
        if (Date.parse(preview.binding.expiresAt) <= Date.now()) previews.delete(id);
      if (previews.size >= 512)
        throw fail("Too many active transit previews; retry after expiry", 503);
      const value = {
        preflightId,
        expiresAt,
        countries: snapshot.countries,
        allowedCountries: snapshot.allowedCountries,
        result: snapshot.result,
      };
      const fingerprint = hash(value),
        binding = {
          preflightId,
          fingerprint,
          expiresAt,
          sourceFingerprint: snapshot.sourceFingerprint,
        };
      previews.set(preflightId, { fingerprint, binding, countries: snapshot.countries });
      return { ...value, fingerprint };
    },
    async verify(request: { countries: string[]; preflightId: string; fingerprint: string }) {
      const countries = normalizeTransitPreflightCountries(request.countries, options.policy),
        preview = previews.get(request.preflightId);
      if (
        !preview ||
        preview.fingerprint !== request.fingerprint ||
        canonicalJson(countries) !== canonicalJson(preview.countries) ||
        Date.parse(preview.binding.expiresAt) <= Date.now()
      )
        throw fail("Transit preflight expired or changed; preview again");
      await verifyTransitPreflightBinding(options, countries, preview.binding);
      return preview.binding;
    },
  };
}
export async function verifyTransitPreflightBinding(
  options: TransitPreflightOptions,
  countries: string[],
  binding: TransitPreflightBinding,
) {
  if (Date.parse(binding.expiresAt) <= Date.now())
    throw fail("Transit preflight expired; preview again");
  const current = await collectTransitPreflight(options, countries);
  if (current.sourceFingerprint !== binding.sourceFingerprint || !current.result.ok)
    throw fail("Transit inputs or available capacity changed; preview again");
}
