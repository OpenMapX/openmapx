# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in OpenMapX, please report it privately.

**Do not open a public issue.** Public issues are read by everyone, and a
vulnerability report becomes a free attack guide before a fix is shipped.

Use one of:

1. **GitHub Security Advisory** — open a draft advisory at
   <https://github.com/Medformatik/openmapx/security/advisories/new>. This is
   the preferred channel.
2. **Email** — send details to the maintainer listed in the repository's
   [GitHub `SECURITY` contact](https://github.com/Medformatik/openmapx).

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The affected component (`apps/web`, `apps/api`, a specific service or
  integration, a CLI command, etc.) and version / commit SHA.
- Whether the issue requires authentication, an admin role, a specific
  integration to be enabled, or a self-hosted service to be reachable.

You'll get an acknowledgement within **3 business days**. A fix plan and ETA
follow once the report is triaged.

## Supported versions

OpenMapX is pre-1.0. Only the latest commit on `main` and the most recent
tagged release receive security fixes. Older releases are not patched.

## Scope

In scope:

- `apps/web` (Next.js frontend / BFF)
- `apps/api` (Fastify API gateway)
- `services/app-web` and `services/app-api` (admin app and admin API)
- `packages/cli` (`openmapx` CLI)
- First-party integrations under `integrations/`
- Generated `docker-compose.yml` output

Out of scope (report upstream instead):

- Upstream services bundled as Docker images (Valhalla, Nominatim, MOTIS,
  Pelias, MapLibre tile servers, PostgreSQL, etc.).
- Third-party APIs that integrations query (MapTiler, Mapillary, transit
  agency APIs, etc.).
- Community integrations distributed from external repositories. Report
  those to their authors first; if a vulnerability affects the integration
  loading or sandboxing mechanism in OpenMapX itself, that *is* in scope.

## Self-hosted deployment hardening

If you self-host OpenMapX, a few recommendations:

- Rotate the secrets in `.env` / `infra/docker/.env` away from the example
  values (`BETTER_AUTH_SECRET`, database passwords, `LOCAL_ADMIN_TOKEN`).
- Terminate TLS at Traefik (the default config provisions Let's Encrypt
  certificates).
- Restrict admin routes to a trusted network or VPN where possible.
- Treat community integrations as untrusted code — review the manifest and
  source before installing.
- Subscribe to the repository's "Releases only" notifications so security
  releases reach you.

Thanks for helping keep OpenMapX and its users safe.
