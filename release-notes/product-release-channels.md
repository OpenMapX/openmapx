---
impacts: [breaking, operator-action]
---

## What changes

Product release selection uses main, preview, an exact prerelease version or metadata digest, or explicit local mode. A selected release pins its five images in the configuration generation; there is no hand-written release overlay. Admin apply uses the exact checked release and fails if its selection configuration changed.

## Who is affected

Operators who used hand-written release overlays or local helper build fallback need to update their configuration. The preview channel does not exist until the first named prerelease is deliberately published.

## Required action

Select a release with OPENMAPX_RELEASE and optional OPENMAPX_RELEASE_MANIFEST_REPOSITORY, or opt out with OPENMAPX_RELEASE=local. Re-render and update the operations agent from the host. Explicitly reselect a coherent release with pnpm openmapx compose release before updating services; never select preview as a fallback before publication. Pins stay in the applied configuration until explicitly reselected or cleared. Exact helper pull failures cannot build replacement bytes, even in local mode. `openmapx control rollback` refuses to return to a release older than the database's newest migration.
