import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Whether the checkout is there at `rootDir`. The operations agent runs with
 * either the whole checkout mounted at its host path, or only `infra/docker`
 * (read-only, for `.env` and the overrides) with its state, data, secrets and
 * backups directories (read-write) at the same paths. Everything it reads from
 * a checkout is under the checkout's `services` directory, so that directory,
 * a real one and not a link, is the one test. The host's CLI always runs from
 * a checkout.
 */
export function checkoutMounted(rootDir: string): boolean {
  try {
    const stats = lstatSync(join(rootDir, "services"));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/** `checkoutMounted` for the checkout `infra/docker` belongs to. */
export function checkoutMountedAt(infraDir: string): boolean {
  return checkoutMounted(resolve(infraDir, "..", ".."));
}

/** What the agent's log says about its mounts when it starts. */
export function describeMountLayout(rootDir: string): string {
  return checkoutMounted(rootDir)
    ? `The checkout is mounted at ${rootDir}.`
    : `The checkout is not mounted: only ${join(rootDir, "infra", "docker")} and its state, data, secrets and backups directories are. Everything comes from this release's image and the agent's state.`;
}

/**
 * Something only a checkout can do once, which this operations agent can't,
 * having none: a render on the host does it. The admin panel shows the message.
 */
export class CheckoutRequiredError extends Error {
  override name = "CheckoutRequiredError";
}
