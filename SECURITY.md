# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/OpenMapX/openmapx/security/advisories/new), or email **security@openmapx.org**.

Avoid including vulnerability details in a public issue. Private reporting lets us investigate and coordinate disclosure with you. If you need encrypted email, ask about the project's PGP key first.

Include what you know:

- The affected version or commit and component.
- What happens, its potential impact, and reproduction steps or a small example where possible.
- Whether authentication, a particular integration, configuration or reachable service is required.

An incomplete report is still useful; you do not need to establish the full impact before contacting us.

## Response and disclosure

During OpenMapX's experimental phase, we aim to acknowledge reports within **seven calendar days** and provide an initial assessment or meaningful status update within **fourteen calendar days**. These are best-effort targets. Credible urgent reports receive priority.

We will keep you informed and coordinate mitigation, fixes and public disclosure with you. The appropriate timing depends on the finding; we cannot promise a universal repair deadline. We will credit you unless you prefer to remain anonymous.

If you have not received an acknowledgement after seven calendar days, please send a brief follow-up using the other reporting route if possible.

## Versions receiving fixes

OpenMapX is experimental and its contracts are still evolving. Fixes land on active main development and the most recent named preview when one has been published. Older previews are not maintained. There is no supported stable release commitment yet.

## Temporary dependency exceptions

### `image-size` malformed-image denial of service

- **Advisories:** GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq.
- **Exact versions:** `image-size@1.2.1` in the root lockfile and
  `image-size@2.0.4` in the standalone docs lockfile.
- **Reachability:** build/development tooling only. Metro reaches 1.2.1 during
  mobile work, and Docusaurus reaches 2.0.4 during docs work; neither package is
  part of the API runtime.
- **Mitigation:** pnpm applies
  `patches/image-size@1.2.1.patch` and
  `docs/patches/image-size@2.0.4.patch`. The patches reject malformed ICNS and
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
  sandboxing mechanism in OpenMapX itself, that _is_ in scope.
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
- Treat PostgreSQL snapshots as sensitive user-data copies. Ordinary synchronized
  content is not end-to-end encrypted, and deleting a live account does not
  rewrite an existing backup. Restrict and encrypt off-host copies as appropriate,
  set an expiry policy, and review the
  [user-data trust model](docs/docs/developer/user-data-trust-model.md).
- Subscribe to the repository's "Releases only" notifications so security
  releases reach you.

Thanks for helping keep OpenMapX and its users safe.
