# Package Changesets

Changesets manages independent versions and changelogs for the qualified public packages: `@openmapx/extension-contracts` and `@openmapx/extension-cli`. Both start this baseline at their existing `0.1.0`; clearing the old queue does not publish them or increment their versions. Private workspaces are not versioned or tagged by Changesets.

Add a note when a contribution changes a qualified package's delivered artifact or consumer contract:

```bash
pnpm exec changeset
```

Use a patch for compatible fixes and a minor for new features or incompatible changes while a package is below `1.0.0`. Explain incompatible changes and how consumers should update. A move to `1.0.0` is a deliberate package maturity decision, not a result of an old major-bump request.

For a change that does not need a release, use the specific explanation described in [Contributing](../CONTRIBUTING.md#release-information). Do not add empty notes or select private implementation packages. Product release notes belong in [release-notes/](../release-notes/README.md), separately from package versions.

The old mixed queue was cleared without applying its bumps. Its contents remain in [Git history](https://github.com/OpenMapX/openmapx/tree/c9f66f2b21acc2f48eeb2aa6e63a9625f340362f/.changeset). Important upgrade instructions are retained in the [pre-baseline upgrade note](../release-notes/pre-baseline-upgrades.md).

Use the manual-only [package release workflow](../docs/docs/developer/package-releases.md) to prepare a canonical version PR, qualify exact candidates, and separately approve publication. An empty queue is a no-op. Initial npm setup and first publication require separate authorization; qualification never bootstraps or publishes. A version PR must match the canonical Changesets transformation checked by CI; automatic Changesets formatting is disabled so that replay does not invoke a package manager or change the lockfile.
