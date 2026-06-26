import { COMMUNITY_SAFE_CAPS } from "./manifest-schema";
import type { ServiceManifest } from "./types";

// A deterministic, informational security rating for a *service* manifest,
// modeled on Home Assistant's add-on rating but adapted to OpenMapX: community
// services already pass a hard capability *sandbox* at validation (docker-socket,
// host networking, privileged, devices, `@`-special binds are rejected outright),
// so this score grades within the allowed envelope and flags anything that can
// only run as a built-in service. Integrations get no rating — they run
// in-process with full access and instead carry an explicit disclosure.

export interface ServiceSecurityRating {
  /** 1 (least contained) … 8 (most contained). */
  score: number;
  /** Uses capabilities/privileges only a built-in (first-party) service may have. */
  requiresBuiltIn: boolean;
  /** Number of host ports the service publishes (0 = inter-container only). */
  hostPorts: number;
  /** Number of credential fields the operator must supply. */
  secretCount: number;
  /** Human-readable score breakdown (each line is a + / - contribution). */
  factors: string[];
}

const MIN_SCORE = 1;
const MAX_SCORE = 8;
const BASE_SCORE = 5;

function countSecretFields(configSchema: Record<string, unknown> | undefined): number {
  if (!configSchema) return 0;
  const props = (configSchema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return 0;
  let n = 0;
  for (const value of Object.values(props)) {
    if (
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>)["x-openmapx-secret"]
    ) {
      n += 1;
    }
  }
  return n;
}

export function computeServiceSecurityRating(manifest: ServiceManifest): ServiceSecurityRating {
  const c = manifest.container;
  const factors: string[] = [];
  let score = BASE_SCORE;

  const hostPorts = manifest.exposure?.hostPorts?.length ?? 0;
  const secretCount = countSecretFields(manifest.configSchema);

  const elevatedCaps = (c.capAdd ?? []).filter((cap) => !COMMUNITY_SAFE_CAPS.has(cap));
  const usesSpecialBind = (manifest.bindMounts ?? []).some((b) => b.source.startsWith("@"));
  const requiresBuiltIn =
    Boolean(c.privileged) ||
    c.networkMode === "host" ||
    (c.devices?.length ?? 0) > 0 ||
    elevatedCaps.length > 0 ||
    usesSpecialBind;

  if (manifest.exposure?.proxy?.authRequired) {
    score += 1;
    factors.push("+1 authentication required in front of exposed routes");
  }

  if (hostPorts === 0) {
    score += 1;
    factors.push("+1 no host ports published (inter-container only)");
  } else {
    score -= hostPorts;
    factors.push(`-${hostPorts} publishes ${hostPorts} host port(s)`);
  }

  if (manifest.ownsSchema) {
    score += 1;
    factors.push("+1 writes only its own scoped database schema");
  }

  if (requiresBuiltIn) {
    score -= 2;
    const reasons: string[] = [];
    if (c.privileged) reasons.push("privileged");
    if (c.networkMode === "host") reasons.push("host networking");
    if ((c.devices?.length ?? 0) > 0) reasons.push("device passthrough");
    if (elevatedCaps.length > 0) reasons.push(`elevated caps (${elevatedCaps.join(", ")})`);
    if (usesSpecialBind) reasons.push("host bind mounts");
    factors.push(`-2 uses elevated privileges (built-in only): ${reasons.join(", ")}`);
  }

  score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));

  return { score, requiresBuiltIn, hostPorts, secretCount, factors };
}
