# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in OpenMapX, please report it privately.

**Do not open a public issue.** Public issues are read by everyone, and a
vulnerability report becomes a free attack guide before a fix is shipped.

Use one of:

1. **GitHub Security Advisory** (preferred) — open a draft advisory at
   <https://github.com/OpenMapX/openmapx/security/advisories/new>. This keeps
   the report private and lets us collaborate on a fix and a coordinated
   disclosure in one place.
2. **Email** — write to **security@openmapx.org**. If you wish to encrypt your
   report, ask for our PGP key in your first message.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The affected component (`apps/web`, `apps/api`, a specific service or
  integration, a CLI command, etc.) and the version / commit SHA.
- Whether the issue requires authentication, an admin role, a specific
  integration to be enabled, or a self-hosted service to be reachable.

## Our commitment

- **Acknowledgement** within **3 business days** of your report.
- **Triage and an initial assessment** (including severity and a fix plan)
  within **10 business days**.
- We will keep you informed of progress, credit you in the advisory and release
  notes (unless you prefer to remain anonymous), and coordinate the public
  disclosure date with you.
- Our target is to ship a fix within **90 days** of triage; complex issues may
  take longer, and we will say so.

If you have not received an acknowledgement within 6 business days, please send a
brief follow-up in case the original report was missed.

## Supported versions

OpenMapX is pre-1.0. Only the latest commit on `main` and the most recent
tagged release receive security fixes. Older releases are not patched.

## Temporary dependency exceptions

### `image-size` malformed-image denial of service

- **Advisories:** GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq.
- **Exact versions:** `image-size@1.2.1` in the root lockfile and
  `image-size@2.0.2` in the standalone docs lockfile.
- **Reachability:** build/development tooling only. Metro reaches 1.2.1 during
  mobile work, and Docusaurus reaches 2.0.2 during docs work; neither package is
  part of the API runtime.
- **Mitigation:** pnpm applies
  `patches/image-size@1.2.1.patch` and
  `docs/patches/image-size@2.0.2.patch`. The patches reject malformed ICNS and
  ISO-BMFF/JXL/HEIF box traversal, and
  `scripts/check-image-size-dos.mjs` probes every installed vulnerable public
  entry under isolated child-process deadlines.
- **Audit handling:** scanners may continue to report the vulnerable version
  ranges. The findings remain visible and are not suppressed; the checked-in
  patches and passing regression probe are required while this exception is
  active.
- **Owner:** Security maintainers.
- **Review cadence:** monthly. Prefer a maintained replacement or upstream/fork
  release that fixes both advisories over renewing local patches.
- **Expires:** 2026-11-23. A fresh security review is required before changing
  this date or carrying the exception beyond it.

## Scope

In scope:

- `apps/web` (Next.js frontend / BFF, including the admin panel)
- `apps/api` (Fastify API gateway, including the admin API routes)
- `packages/cli` (`openmapx` CLI) and the published `@openmapx/*` packages
- First-party integrations under `integrations/` and services under `services/`
  (the manifests and any first-party daemon code such as `data-manager`)
- The generated `docker-compose.yml` output and default deployment configuration

Out of scope (report upstream instead):

- Upstream services bundled as Docker images (Valhalla, Nominatim, MOTIS,
  Pelias, MapLibre tile servers, PostgreSQL, etc.).
- Third-party APIs that integrations query (MapTiler, Mapillary, transit
  agency APIs, etc.).
- Community integrations distributed from external repositories. Report those to
  their authors first. If a vulnerability affects the integration loading or
  sandboxing mechanism in OpenMapX itself, that *is* in scope.
- Findings that require a misconfigured or out-of-date self-hosted deployment,
  physical access, or social engineering of a maintainer.

## Safe harbor

We consider security research conducted in good faith under this policy to be
authorized. We will not pursue or support legal action against anyone who:

- makes a good-faith effort to comply with this policy,
- avoids privacy violations, data destruction, and degradation of service to
  others (test only against your own deployment), and
- gives us a reasonable opportunity to fix an issue before disclosing it
  publicly.

If in doubt about whether an action is acceptable, ask us first via the channels
above.

## Self-hosted deployment hardening

If you self-host OpenMapX, a few recommendations:

- Generate unique secrets in `infra/docker/.env` before the first render.
  `POSTGRES_PASSWORD` must be at least 24 characters, must not be a known
  placeholder, and must not match the database username. The CLI and both
  production database clients enforce this without echoing rejected values.
- Terminate TLS at Traefik (the default config provisions Let's Encrypt
  certificates).
- Restrict admin routes to a trusted network or VPN where possible.
- Treat community integrations as untrusted code — review the manifest and
  source before installing.
- Keep generated credentials and mobile signing output out of the repository's
  root Docker build context. Run `pnpm check-docker-context-secrets` after
  changing `.dockerignore`, Dockerfiles, or build contexts; the check enumerates
  ignored path names but never opens candidate secret files.
- Treat persisted application logs as sensitive operational data. Current API
  logs are bounded and redact request data, credentials, and raw external URLs,
  but historical `app_logs` rows from an older release may not be. Back up the
  database and follow the operator-controlled cutoff procedure in
  [Monitoring & logs](docs/docs/administration/monitoring.md#purging-historical-application-logs);
  upgrades never delete these records automatically.
- Subscribe to the repository's "Releases only" notifications so security
  releases reach you.

Thanks for helping keep OpenMapX and its users safe.
