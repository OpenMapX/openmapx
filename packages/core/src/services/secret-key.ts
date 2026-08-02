/**
 * Shape guard for credential-vault key names.
 *
 * A service manifest's `configSchema` may declare fields flagged
 * `x-openmapx-secret: true`. Those key names are not merely labels — the
 * render step turns each one into
 *   - a FILENAME under `infra/docker/.generated-secrets/<serviceId>/<key>`,
 *   - a Docker secret target mounted at `/run/secrets/<key>`, and
 *   - an environment variable name `<key>_FILE`.
 *
 * Service manifests can come from third-party community/extension repos, so a
 * key name is untrusted input. Without a shape guard a key such as `../../x`
 * escapes the generated-secrets directory and writes an arbitrary file on the
 * host checkout, which the app-api container bind-mounts read-write.
 *
 * The accepted shape is the union of the three key conventions already in use:
 * SCREAMING_SNAKE service keys (`NY_511_API_KEY`), camelCase integration keys
 * (`apiKey`), and the lowercase hyphenated `<sourceId>-<field>` credential keys
 * that `scripts/check-credential-keys.ts` enforces
 * (`de-nw-mobidrom-scooter-client-id`). It excludes `.`, `/`, `\\`, `%`, NUL and
 * whitespace, so no accepted key can traverse a directory or name a hidden
 * file, and it bounds the length so a key cannot blow past filesystem limits.
 */
export const SECRET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** True when `key` is safe to use as a secret filename / env-var stem. */
export function isValidSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Throwing form of {@link isValidSecretKey}, for non-HTTP call sites. */
export function assertValidSecretKey(key: string): void {
  if (!isValidSecretKey(key)) {
    throw new Error(
      `Invalid credential key "${key}" — must be 1-64 characters of letters, digits, "_" or "-", starting with a letter or digit`,
    );
  }
}
