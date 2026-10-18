---
impacts: [breaking, operator-action]
---

## What changes

Product release selection uses main, preview, an exact prerelease version or metadata digest, or explicit local mode. The former full-image configuration is rejected. Existing overlays must contain a coherent seven-image selection; incomplete hand-written overlays are rejected. Admin apply uses the exact checked release and fails if its selection configuration changed.

## Who is affected

Operators using OPENMAPX_RELEASE_MANIFEST_IMAGE, hand-written overlays, or local helper build fallback need to update their configuration. The preview channel does not exist until the first named prerelease is deliberately published.

## Required action

Replace the old full image with OPENMAPX_RELEASE and optional OPENMAPX_RELEASE_MANIFEST_REPOSITORY. Replace an empty opt-out with OPENMAPX_RELEASE=local. Re-render and update the operations agent from the host. Explicitly reselect a coherent release with pnpm openmapx compose release before updating services; never select preview as a fallback before publication. Keep deliberate pins until explicitly reselected or cleared. Exact helper pull failures cannot build replacement bytes, even in local mode. Image rollback does not reverse database migrations.
