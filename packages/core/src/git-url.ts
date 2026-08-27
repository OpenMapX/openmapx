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

export interface AllowedGitUrl {
  /** The parsed URL after normalization. */
  url: URL;
  /** Credential-, query- and fragment-free string safe to log, store, and hash. */
  canonical: string;
  /** Lowercased hostname, safe to include in an error. */
  hostname: string;
}

/**
 * Validate that `url` is a credential-free https URL pointing at an allowlisted
 * host, and return its canonical form.
 *
 * Errors deliberately state only the rule that failed plus — when it is already
 * known safe — the normalized hostname. The raw input is never echoed: it may
 * carry a token in userinfo, query, or fragment.
 */
export function assertAllowedGitUrl(url: string): AllowedGitUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidGitUrlError("Not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidGitUrlError("Only https:// repository URLs are supported");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InvalidGitUrlError("Repository URL must not embed credentials");
  }
  if (parsed.search !== "") {
    throw new InvalidGitUrlError("Repository URL must not carry a query string");
  }
  if (parsed.hash !== "") {
    throw new InvalidGitUrlError("Repository URL must not carry a fragment");
  }
  // `URL` already lowercases the hostname and drops the default :443, so
  // `host` is the normalized authority. A non-default port is a different
  // endpoint and is not allowlisted.
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.port !== "") {
    throw new InvalidGitUrlError(`Repository host ${hostname} must use the default https port`);
  }
  if (!ALLOWED_GIT_HOSTS.has(hostname)) {
    throw new InvalidGitUrlError(`Host ${hostname} is not in the repository allowlist`);
  }
  const canonical = `https://${hostname}${parsed.pathname.replace(/\/{2,}/g, "/")}`;
  return { url: new URL(canonical), canonical, hostname };
}

/** Convenience wrapper returning only the canonical string. */
export function canonicalGitUrl(url: string): string {
  return assertAllowedGitUrl(url).canonical;
}
