import { COMMUNITY_SAFE_CAPS, isComposeVarReference } from "./sandbox-policy";
import type { ServiceManifest } from "./types";

// A deterministic, informational security rating for a *service* manifest,
// modeled on Home Assistant's add-on rating but adapted to OpenMapX: community
// services already pass a hard capability *sandbox* at validation (docker-socket,
// host networking, privileged, devices, unsafe capabilities, `@`-special binds,
// env_file, Compose-variable bind paths, and unnamespaced volumes are rejected
// outright), so this score grades within the allowed envelope and flags anything
// that can only run as a built-in service. Integrations get no rating — they run
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
  /** Distinct deployment environment variables referenced by the manifest. */
  deploymentVariables: string[];
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

const COMPOSE_VARIABLE_REGEX =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::[-+?]|[-+?])[^{}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function collectDeploymentVariables(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(COMPOSE_VARIABLE_REGEX)) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDeploymentVariables(item, names);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectDeploymentVariables(item, names);
  }
}

export function computeServiceSecurityRating(manifest: ServiceManifest): ServiceSecurityRating {
  const c = manifest.container;
  const factors: string[] = [];
  let score = BASE_SCORE;

  const hostPorts = manifest.exposure?.hostPorts?.length ?? 0;
  const secretCount = countSecretFields(manifest.configSchema);
  const deploymentVariableNames = new Set<string>();
  collectDeploymentVariables(manifest, deploymentVariableNames);
  const deploymentVariables = [...deploymentVariableNames].sort();

  const elevatedCaps = (c.capAdd ?? []).filter((cap) => !COMMUNITY_SAFE_CAPS.has(cap));
  const usesSpecialBind = (manifest.bindMounts ?? []).some((b) => b.source.startsWith("@"));
  const usesComposeVarBind = (manifest.bindMounts ?? []).some(
    (b) => isComposeVarReference(b.source) || isComposeVarReference(b.target),
  );
  const usesEnvFile = (c.envFile?.length ?? 0) > 0;
  const requiresBuiltIn =
    Boolean(c.privileged) ||
    c.networkMode === "host" ||
    (c.devices?.length ?? 0) > 0 ||
    elevatedCaps.length > 0 ||
    usesSpecialBind ||
    usesEnvFile ||
    usesComposeVarBind;

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
    if (usesEnvFile) reasons.push("deployment env_file");
    if (usesComposeVarBind) reasons.push("Compose-variable bind paths");
    factors.push(
      `-2 uses elevated or first-party-only resources (built-in only): ${reasons.join(", ")}`,
    );
  }

  if (deploymentVariables.length > 0) {
    score -= 2;
    factors.push(
      `-2 reads ${deploymentVariables.length} deployment environment variable(s): ${deploymentVariables.join(", ")}`,
    );
  }

  score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));

  return { score, requiresBuiltIn, hostPorts, secretCount, deploymentVariables, factors };
}
