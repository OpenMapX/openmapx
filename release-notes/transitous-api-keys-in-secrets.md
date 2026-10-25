---
impacts: [operator-action]
---

## What changes

The Transitous API keys for restricted feeds move out of the checkout, from
`services/motis/tools/transitous/api-keys.json` to
`infra/docker/secrets/transitous-api-keys/api-keys.json`. data-manager reads
them from the same path in its container as before, `/config/transitous/api-keys.json`,
through a read-only mount of that directory. `pnpm openmapx data generate-api-keys`
writes the new file.

The first compose render copies the earlier file, leaving it in place for a
rollback. It copies it only when it is a regular file of the deployment's user
with one link that neither its group nor others can write, holding a JSON
object of key strings. Otherwise the new file starts empty and the render's
output names the earlier file and why it stayed.

## Who is affected

Installations that set keys for restricted Transitous feeds. A checkout cloned
or pulled under a umask of `002`, the Debian and Ubuntu default, usually has a
group-writable key file, which is not copied.

## Required action

After the update, read the render's output, or run `pnpm openmapx check` (**Run
diagnostics** in the admin panel), which keeps reporting it for as long as the
earlier file sets keys the new one doesn't. When the earlier file was left in
place, check it and copy its keys into
`infra/docker/secrets/transitous-api-keys/api-keys.json`, or run
`pnpm openmapx data generate-api-keys` and enter them again. Until then those
feeds run without their keys. Edit the keys in the new file from now on; the
earlier file is no longer read.
