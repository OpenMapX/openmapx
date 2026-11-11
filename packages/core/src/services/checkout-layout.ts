import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Whether the checkout is there at `rootDir`. The host's CLI always runs from
 * a checkout. The operations agent never has one: it mounts only
 * `infra/docker` (read-only, for `.env` and the overrides) with its state,
 * data, secrets, backups and catalog-pins directories (read-write) at the
 * same paths, as its manifest declares. Everything a process reads from a checkout is under
 * the checkout's `services` directory, so that directory, a real one and not
 * a link, is the one test.
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

/**
 * Something only a checkout can do once, which this operations agent can't,
 * having none: a render on the host does it. The admin panel shows the message.
 */
export class CheckoutRequiredError extends Error {
  override name = "CheckoutRequiredError";
}
