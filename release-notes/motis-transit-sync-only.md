---
impacts: [breaking, operator-action]
---

## What changes

MOTIS data is now built only by the managed transit sync (Admin → Data →
Transit → Sources → **Review transit sync**, or `pnpm openmapx data sync`). It
acquires the pinned catalog's feeds, imports and probes a candidate and promotes
it, including the first dataset on an empty installation.

The host MOTIS build is gone:

- `pnpm openmapx services build motis` and its `--import` flag no longer exist,
  and `services build-all` skips MOTIS.
- The admin **Build** and **Build All** actions no longer offer MOTIS or the
  "Import MOTIS after build" option.
- Full Update no longer builds MOTIS after its transit sync step; the sync
  itself refreshes MOTIS.

The release now pins five application images instead of six. The
`transitous-tools` image is no longer built or published, and updates no longer
download it. Data-manager no longer sets `OPENMAPX_TRANSITOUS_TOOLS_IMAGE`, and
its image no longer contains Python, `gtfsclean`, `age`, `wget`, `rsync` or the
SSH client; the Transitous runner runs the catalog scripts.

`data export motis` needs a MOTIS build record, which transit sync does not
write yet, so a candidate that transit sync promoted cannot be exported. Build
MOTIS on the host that serves it; exporting a managed candidate is planned.

## Who is affected

Every installation that runs MOTIS, and anyone whose scripts call
`services build motis` or use the `transitous-tools` image.

## Required action

Seed and refresh MOTIS with a transit sync instead of a MOTIS build. Set
`MOTIS_TWO_SLOT=true` before the first sync of a new installation. Remove
`services build motis` from scripts and the `transitous-tools` image from
mirrors or pull lists. Nothing is converted: install from empty state, without
a release manifest, generation or cached image list that names six images.
