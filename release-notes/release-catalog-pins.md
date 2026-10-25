---
impacts: [security, breaking]
---

## What changes

The MobilityData GBFS registry pin is the release's. The operations agent
answers data-manager's GBFS compiler from the copy of
`infra/docker/gbfs-catalog.lock.json` its image carries, so a pin planted in a
checkout that its group can write is never used.

No operator CLI command rewrites tracked files any more:

- `pnpm openmapx transit-registry bump` and `transit-registry show` are removed.
  Maintainers pin the transport-apis catalog with `pnpm pin:transport-apis` in
  a development checkout.
- `pnpm openmapx transitous bump` proposes only a Transitous pin
  (`infra/docker/transitous.lock.proposed.json`); it no longer writes a GBFS
  proposal, which nothing activated. Maintainers pin the GBFS registry with
  `pnpm pin:gbfs-catalog`.

## Who is affected

Every Docker deployment, and anyone who ran `openmapx transit-registry` on a
host.

## Required action

None. A `gbfs-catalog.lock.proposed.json` an earlier `transitous bump` left in
`infra/docker` is no longer read or written; it can be deleted.
