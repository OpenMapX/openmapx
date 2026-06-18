// Defense-in-depth allowlist for Git repository URLs that the platform will
// clone on behalf of an admin (community service repos + community
// integrations). Admin-only endpoints already gate access, but `git clone` of
// an arbitrary `file:///`, `ssh://`, or intranet URL would let an admin pull
// host-local content into the install tree or coerce credentialed fetches —
// so we keep the protocol locked to https and the host locked to a small set
// of well-known public Git hosts.
//
// Both the service-repositories registrar (`apps/api/src/services/
// service-repositories.ts`) and the integration installer
// (`packages/core/src/integration/installer.ts`) call into this module so the
// two paths can't drift.

export const ALLOWED_GIT_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "codeberg.org",
  "bitbucket.org",
  "git.sr.ht",
]);

export class InvalidGitUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitUrlError";
  }
}

/**
 * Validate that `url` is an https URL pointing at one of the allowlisted hosts.
 * Returns the parsed `URL` on success; throws `InvalidGitUrlError` otherwise.
 */
export function assertAllowedGitUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidGitUrlError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidGitUrlError(
      `Only https:// repository URLs are supported (got ${parsed.protocol})`,
    );
  }
  if (!ALLOWED_GIT_HOSTS.has(parsed.host)) {
    throw new InvalidGitUrlError(
      `Host ${parsed.host} is not in the allowlist (${[...ALLOWED_GIT_HOSTS].join(", ")})`,
    );
  }
  return parsed;
}
