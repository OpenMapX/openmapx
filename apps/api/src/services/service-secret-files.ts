import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidSecretKey } from "@openmapx/core/services/secret-key";

/** Directory (under infra/docker) holding the rendered per-service secret files. */
export const GENERATED_SECRETS_DIR = ".generated-secrets";

/**
 * Full-regeneration write of the per-service secret files consumed via Docker
 * `secrets:`. The whole tree is removed first, so a credential deleted in the
 * admin panel leaves no stale file behind (the staleness guarantee). Values are
 * written verbatim (no trailing newline); consumers trim on read.
 *
 * Permissions: the directories are 0700 (root-only) — that ACL is the security
 * boundary, so a non-root host user cannot traverse into them. The files are
 * world-readable 0444 because Docker Compose (outside swarm) IGNORES per-secret
 * uid/gid/mode and bind-mounts the source file into the container's /run/secrets
 * with the source file's own ownership/mode; a service that runs as a non-root
 * user (e.g. the ingest container, uid 1001) can therefore only read its secret
 * if the source file itself is world-readable. This mirrors Docker's own secret
 * default (0444) and exposes nothing on the host thanks to the 0700 dir. We
 * chmod after write because writeFileSync's mode is masked by the process umask.
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
      // Last line of defence: keys reaching here come from the vault, which can
      // still hold a row stored under an older manifest. A key must never be
      // able to escape this service's directory.
      assertValidSecretKey(key);
      const file = join(dir, key);
      writeFileSync(file, value, { mode: 0o444 });
      chmodSync(file, 0o444);
    }
  }
}
