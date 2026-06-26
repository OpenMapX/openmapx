import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory (under infra/docker) holding the rendered per-service secret files. */
export const GENERATED_SECRETS_DIR = ".generated-secrets";

/**
 * Full-regeneration write of the per-service secret files consumed via Docker
 * `secrets:`. The whole tree is removed first, so a credential deleted in the
 * admin panel leaves no stale file behind (the staleness guarantee). Files are
 * 0600 and the directories 0700. Values are written verbatim (no trailing
 * newline); consumers trim on read.
 *
 * Pure filesystem only (no DB/registry imports) so it can be unit-tested in
 * isolation. `secretsBySvc` maps a service id to its `{ key: decryptedValue }`.
 */
export function regenerateServiceSecretFiles(
  infraDir: string,
  secretsBySvc: Map<string, Record<string, string>>,
): void {
  const root = join(infraDir, GENERATED_SECRETS_DIR);
  rmSync(root, { recursive: true, force: true });
  if (secretsBySvc.size === 0) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [serviceId, secrets] of secretsBySvc) {
    const dir = join(root, serviceId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [key, value] of Object.entries(secrets)) {
      writeFileSync(join(dir, key), value, { mode: 0o600 });
    }
  }
}
