---
impacts: [operator-action]
---

## What changes

Traefik's configuration moves out of the checkout. Its dynamic directory, which
Traefik watches and reloads as soon as a file changes, is now
`infra/docker/state/ops-agent/traefik/dynamic`: render writes the routes there,
with copies of the YAML and TOML files of `services/traefik/config/dynamic`
(the release's `middlewares.yml`, and an operator's `auth.yml`), each replaced
atomically. Traefik's static `traefik.yml` is copied into each configuration
generation, which Traefik reads when it starts. Render still reads both from
`services/traefik/config`, so that is where you edit them for now.

Render copies only regular files of the deployment's user with one link, from
directories of that user, never through a symbolic link. It names any other
file in its output and in `pnpm openmapx check`, without its contents, and
keeps the copy an earlier render made of it. A file removed from
`services/traefik/config/dynamic` is removed from the new directory by the next
render. The directory is owner-only (0700, files 0600); Traefik runs as
root and reads it.

A Traefik started by an earlier release keeps reading the checkout's
`services/traefik/config/dynamic` until it is recreated. While any container,
running or stopped, still mounts that directory, render keeps writing the
routes there too, and render, `pnpm openmapx check` and **Run diagnostics** in
the admin panel say so. Render stops writing there on its own once no container
mounts it; the file is left in place for a rollback.

Related fix: a selection in which no service strips a path prefix, such as the
default one, rendered `middlewares: {}`, and Traefik refused the whole routes
file, so it served no routes. Render now leaves out empty sections.

## Who is affected

Installations that run the bundled Traefik. Installations behind their own
reverse proxy are not affected.

## Required action

None is required: routing keeps working without it. Recreating Traefik is
recommended, so it reads the new directory and its routes stop depending on the
checkout: `pnpm openmapx services update traefik`, or **Recreate** on
**Admin → Services → Traefik**. That restarts the proxy, so the site is
unreachable for a few seconds. OpenMapX does not recreate Traefik itself.

A later release stops mounting the checkout into the operations agent, and
will not do so while a container still mounts Traefik's directory in the
checkout.
