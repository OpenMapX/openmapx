import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { osmPbfName } from "../download-osm.js";
import type { JobLogger } from "./types.js";

/**
 * Post-processors applied to a generated MOTIS `config.yml`.
 *
 * Both `gen-motis-config` (the `--import-only` config the staging MOTIS imports)
 * and `gen-full-config` (the runtime config the live MOTIS serves) emit their
 * own `config.yml`, and the two must agree on every import-affecting setting —
 * the `osm:` extract, `osr_footpath`, and the RT/elevator options. If they
 * diverge, the staging instance imports cleanly against one config but the
 * promoted live instance then re-runs `/motis import` against the other and can
 * fail verification (e.g. a stale `osm: planet-latest.osm.pbf` that doesn't
 * exist on a regional deployment). Sharing the overrides here keeps both
 * configs in lockstep.
 */

/**
 * Flip a `<key>: true|false` YAML scalar in `configPath` from a boolean env var.
 * Shared by the incremental_rt_update and osr_footpath overrides (identical
 * read → regex-flip → write shape). `yamlKey` is a hardcoded literal, so the
 * built RegExp carries no untrusted input.
 *
 * Returns `true` iff the file was modified. Leaves the file (and the Transitous
 * default) untouched when the env var is unset, unrecognised, the file is
 * missing/unreadable, the key is absent, or the value already matches.
 */
function flipYamlBoolFromEnv(
  configPath: string,
  logger: JobLogger,
  opts: { envVar: string; yamlKey: string },
): boolean {
  const { envVar, yamlKey } = opts;
  const raw = process.env[envVar];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  const truthy = ["1", "true", "yes", "on"].includes(normalized);
  const falsy = ["0", "false", "no", "off"].includes(normalized);
  if (!truthy && !falsy) {
    logger.warn(`motis-config: ignoring ${envVar}=${raw} (expected true/false)`);
    return false;
  }
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (error) {
    logger.warn(
      `motis-config: could not read ${configPath} to apply ${yamlKey} override: ${(error as Error).message}`,
    );
    return false;
  }
  const desired = truthy ? "true" : "false";
  const re = new RegExp(`^(\\s*${yamlKey}:\\s*)(true|false)\\s*$`, "m");
  const match = text.match(re);
  if (!match) {
    logger.warn(`motis-config: ${yamlKey} key not found in ${configPath}; override skipped`);
    return false;
  }
  if (match[2] === desired) return false;
  const next = text.replace(re, `$1${desired}`);
  try {
    writeFileSync(configPath, next, "utf-8");
    logger.info(`motis-config: ${yamlKey} set to ${desired} via ${envVar}`);
    return true;
  } catch (error) {
    logger.warn(
      `motis-config: could not write ${yamlKey} override to ${configPath}: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Post-process the generated `config.yml` to flip MOTIS's
 * `incremental_rt_update` flag when the operator opts in via
 * `MOTIS_INCREMENTAL_RT_UPDATE=true`.
 *
 * Upstream Transitous templates the flag as `false` (each RT poll re-applies
 * the full feed against a clean slate). Setting it to `true` preserves the
 * accumulated RT state between polls — lower CPU per cycle but risks
 * carrying stale entities that the upstream feed silently drops. We keep
 * Transitous's default and only honour the override when an operator
 * explicitly sets the env var; otherwise we don't mutate the file at all.
 *
 * Returns `true` iff the file was modified.
 */
export function applyIncrementalRtOverride(configPath: string, logger: JobLogger): boolean {
  return flipYamlBoolFromEnv(configPath, logger, {
    envVar: "MOTIS_INCREMENTAL_RT_UPDATE",
    yamlKey: "incremental_rt_update",
  });
}

/**
 * Post-process the generated `config.yml` to enable MOTIS's elevator
 * (FaSta / SIRI-FM) integration when the operator sets `MOTIS_ELEVATORS_URL`.
 *
 * Upstream Transitous templates `elevators: false`. When enabled, MOTIS polls
 * the configured status API and routes wheelchair (`pedestrianProfile=WHEELCHAIR`)
 * trips around out-of-service elevators in real time. An optional
 * `MOTIS_ELEVATORS_AUTH` supplies an `Authorization` header (e.g. for the DB
 * FaSta API). We only mutate the file when the URL is set; otherwise the
 * Transitous default is left untouched.
 *
 * Returns `true` iff the file was modified.
 */
export function applyElevatorsOverride(configPath: string, logger: JobLogger): boolean {
  const url = process.env.MOTIS_ELEVATORS_URL?.trim();
  if (!url) return false;
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (error) {
    logger.warn(
      `motis-config: could not read ${configPath} to apply elevators override: ${(error as Error).message}`,
    );
    return false;
  }
  const auth = process.env.MOTIS_ELEVATORS_AUTH?.trim();
  const block = [
    "elevators:",
    `  url: ${url}`,
    ...(auth ? ["  headers:", `    Authorization: ${auth}`] : []),
  ].join("\n");
  // Matches the top-level `elevators:` scalar (or a previously-injected block:
  // the key line plus any following indented lines).
  const re = /^elevators:.*(?:\n[ \t]+.*)*$/m;
  if (!re.test(text)) {
    logger.warn(`motis-config: elevators key not found in ${configPath}; override skipped`);
    return false;
  }
  // Use a replacer function so `$` sequences in the URL/auth value (e.g. a token
  // containing `$1` or `$&`) are inserted literally rather than interpreted as
  // String.replace substitution patterns.
  const next = text.replace(re, () => block);
  if (next === text) return false;
  try {
    writeFileSync(configPath, next, "utf-8");
    logger.info(`motis-config: elevators enabled via MOTIS_ELEVATORS_URL (${url})`);
    return true;
  } catch (error) {
    logger.warn(
      `motis-config: could not write elevators override to ${configPath}: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Post-process the generated `config.yml` to flip MOTIS's `osr_footpath` flag
 * when the operator opts in via `MOTIS_OSR_FOOTPATH=true`.
 *
 * Upstream Transitous templates `osr_footpath: false` (transfers come from the
 * timetable feeds). Setting it to `true` makes MOTIS compute transfer footpaths
 * on the OSM street graph instead — more realistic walking transfers, at the
 * cost of extra import time and RAM (~+2-4 GB; validate on `motis-staging`
 * before promoting). Requires `street_routing: true`, which is already set.
 *
 * Returns `true` iff the file was modified.
 */
export function applyOsrFootpathOverride(configPath: string, logger: JobLogger): boolean {
  return flipYamlBoolFromEnv(configPath, logger, {
    envVar: "MOTIS_OSR_FOOTPATH",
    yamlKey: "osr_footpath",
  });
}

/**
 * Point the generated config's `osm:` line at the OSM extract for the
 * deployment's build region, so MOTIS imports the same area as the rest of the
 * stack (osrm/otp/overpass/...). The region resolves from `MOTIS_REGION` then
 * `OPENMAPX_REGION` — the same precedence the CLI's `resolveBuildRegion("motis")`
 * uses — and maps to a filename via {@link osmPbfName} (e.g. `europe/germany` →
 * `europe-germany.osm.pbf`). Upstream Transitous templates `planet-latest.osm.pbf`
 * because it builds a global instance; a regional deployment overrides it here.
 *
 * No region configured, or the generated config has no `osm:` line (transit-only,
 * `street_routing: false`) → leave the upstream default untouched.
 *
 * Returns `true` iff the file was modified.
 */
export function applyOsmRegionOverride(configPath: string, logger: JobLogger): boolean {
  const region = (process.env.MOTIS_REGION ?? process.env.OPENMAPX_REGION)?.trim();
  if (!region) return false;
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (error) {
    logger.warn(
      `motis-config: could not read ${configPath} to apply osm region override: ${(error as Error).message}`,
    );
    return false;
  }
  const re = /^(\s*osm:\s*)(\S+)\s*$/m;
  const match = text.match(re);
  if (!match) return false; // no osm key (transit-only config) — nothing to point
  const desired = osmPbfName(region);
  if (match[2] === desired) return false;
  try {
    writeFileSync(configPath, text.replace(re, `$1${desired}`), "utf-8");
    logger.info(`motis-config: osm set to ${desired} for region ${region}`);
    return true;
  } catch (error) {
    logger.warn(
      `motis-config: could not write osm region override to ${configPath}: ${(error as Error).message}`,
    );
    return false;
  }
}

/** Flags reported back to the stage's `artifacts` for observability. */
export interface ConfigOverrideFlags {
  osmRegionOverridden: boolean;
  incrementalRtOverridden: boolean;
  elevatorsOverridden: boolean;
  osrFootpathOverridden: boolean;
}

/**
 * Apply every MOTIS config post-processor to `configPath`, returning which ones
 * mutated the file. Called by BOTH `gen-motis-config` (import-only config) and
 * `gen-full-config` (runtime config) so the two stay in lockstep — a divergent
 * `osm:` line between them is what previously made every promote roll back.
 */
export function applyConfigOverrides(configPath: string, logger: JobLogger): ConfigOverrideFlags {
  return {
    osmRegionOverridden: applyOsmRegionOverride(configPath, logger),
    incrementalRtOverridden: applyIncrementalRtOverride(configPath, logger),
    elevatorsOverridden: applyElevatorsOverride(configPath, logger),
    osrFootpathOverridden: applyOsrFootpathOverride(configPath, logger),
  };
}
