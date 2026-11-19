---
impacts: [operator-action]
---

## What changes

Each configuration generation now records the local image each service's tag
named when the generation was applied. The operations agent keeps treating a
running container as its own when it runs that recorded image, even after a newer
image was pulled for the same tag.

A Data Manager update downloads the new image first, then commits that exact
image in the new generation and checks the recreated container against it. An
update cancelled after its download no longer refuses later configuration changes
with "Apply or update Data Manager before changing instance configuration"; the
downloaded image stays unused until the next Data Manager update.

## Who is affected

Installations that run tagged images instead of a pinned release, for example with
`OPENMAPX_RELEASE=local`. Pinned releases name their images by digest, which a
pull never moves.

## Required action

On an installation using tags whose only generation was written by its first
`compose up`, apply any configuration change once the stack runs before updating
Data Manager, so the running images are recorded.
