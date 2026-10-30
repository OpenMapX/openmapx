import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { checkoutMountedAt } from "./checkout-layout";
import { CURRENT_CONFIGURATION, GENERATED_COMPOSE_FILE } from "./deployment";
import type { LoadedService, ServiceBindMount } from "./types";

/**
 * How the operations agent's container mounts the checkout's path: the whole
 * checkout, as releases before the switch did, or only `infra/docker`
 * (read-only) with its state, data, secrets and backups directories, as its
 * manifest declares. Only a render on the host moves an agent to `narrow`,
 * once nothing the switch needs is missing; every other render keeps the
 * layout the agent already runs with.
 */
export type AgentMountLayout = "checkout" | "narrow";

const OPS_AGENT = "ops-agent";

/** A manifest source or target at the checkout's path, as Compose substitutes it. */
const AT_CHECKOUT_PATH =
  /^\$(?:\{OPENMAPX_HOST_DIR(?:[:?+-][^}]*)?\}|OPENMAPX_HOST_DIR(?![A-Za-z0-9_]))/;

/** The whole checkout at its host path, which the agent keeps until the switch. */
export const WHOLE_CHECKOUT_AGENT_MOUNT: ServiceBindMount = {
  source:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose substitutes this, as in the manifest
    "${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set — ops-agent renders and applies trusted local stack configuration}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose substitutes this, as in the manifest
  target: "${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set}",
  readOnly: false,
};

/**
 * The bind mounts a service renders with. The built-in operations agent's
 * mounts at the checkout's path are its manifest's narrow ones; in the
 * `checkout` layout the whole checkout takes their place, where the first of
 * them was. Every other service, and every other mount, renders as declared.
 */
export function agentBindMounts(
  service: LoadedService,
  layout: AgentMountLayout | undefined,
): readonly ServiceBindMount[] {
  const mounts = service.manifest.bindMounts ?? [];
  if (layout !== "checkout" || !service.isBuiltIn || service.manifest.id !== OPS_AGENT) {
    return mounts;
  }
  const atCheckout = (mount: ServiceBindMount) =>
    AT_CHECKOUT_PATH.test(mount.source) && AT_CHECKOUT_PATH.test(mount.target);
  const first = mounts.findIndex(atCheckout);
  if (first < 0) return mounts;
  return [
    ...mounts.slice(0, first).filter((mount) => !atCheckout(mount)),
    WHOLE_CHECKOUT_AGENT_MOUNT,
    ...mounts.slice(first).filter((mount) => !atCheckout(mount)),
  ];
}

/** The layout of the agent this process is, or renders for: whether the checkout is there. */
export function runningAgentMountLayout(infraDir: string): AgentMountLayout {
  return checkoutMountedAt(infraDir) ? "checkout" : "narrow";
}

/**
 * The layout the applied generation gives the agent: `checkout` when its
 * compose file mounts the whole checkout into `ops-agent`, `narrow` when it
 * mounts the agent without it, null when there is no generation or no agent.
 */
export function generationAgentMountLayout(infraDir: string): AgentMountLayout | null {
  let compose: unknown;
  try {
    compose = parseYaml(
      readFileSync(join(infraDir, CURRENT_CONFIGURATION, GENERATED_COMPOSE_FILE), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const agent = (compose as { services?: Record<string, { volumes?: unknown }> } | null)
    ?.services?.[OPS_AGENT];
  if (!agent) return null;
  const whole = `${WHOLE_CHECKOUT_AGENT_MOUNT.source}:${WHOLE_CHECKOUT_AGENT_MOUNT.target}`;
  const volumes = Array.isArray(agent.volumes) ? agent.volumes : [];
  return volumes.some((volume) => volume === whole || volume === `${whole}:rw`)
    ? "checkout"
    : "narrow";
}
