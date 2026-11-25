---
impacts: [operator-action]
---

## What changes

OSM changesets name the OpenMapX release that made them. When a configuration
pins a release, `OPENMAPX_VERSION`, which the `created_by` tag reports as
`OpenMapX <version>`, defaults to that release's product version, or to its
release id when it has none. Without a pinned release it stays `1.0`.

## Who is affected

Installations that contribute edits or notes to OpenStreetMap.

## Required action

None. Remove `OPENMAPX_VERSION` from `infra/docker/.env` unless you want
changesets to report another value; a set value still wins.
