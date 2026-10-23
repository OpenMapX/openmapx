# Important product release notes

Commit a short Markdown fragment here for a breaking product change, migration, significant security impact or required operator action. Ordinary features/fixes are curated from PR descriptions at release preparation; internal maintenance normally needs no fragment. Package Changesets are separate and a change can need both.

Use a unique lowercase hyphenated filename, such as `saved-place-storage-migration.md`:

```md
---
impacts: [migration, operator-action]
---

## What changes

Explain the behavior or compatibility change in plain language.

## Who is affected

Identify the installations or users that need to know.

## Required action

Give the action, timing and any recovery limitations. If no action is required,
say so explicitly and explain why.
```

Allowed impacts are `breaking`, `migration`, `security` and `operator-action`. Include every applicable category and keep instructions specific enough for release preparation. Changes to committed API database migration SQL require migration information automatically. For other important effects, declare `Product impact: migration, operator-action` (using the relevant categories) in the PR's **Release and upgrade impact** section. CI checks the declared categories against the new/updated fragments; maintainers review whether the classification is accurate and complete.

Do not put embargoed vulnerability details in a public fragment. Follow [SECURITY.md](../SECURITY.md) and coordinate public release information with disclosure. A fragment does not authorize a release, deployment, data migration or package publication.

Fragments remain pending until the release process deliberately incorporates them. This directory does not reset or consume the historical Changesets queue.

## Preparing product release notes

Fragments remain pending until incorporated into a version-specific release page. During release preparation, maintainers should assemble a version-specific page under `docs/docs/releases/` with:

- Highlights that explain the most useful changes to users.
- Breaking changes and the installations or users they affect.
- Upgrade instructions, including required actions, their timing and any recovery limitations.
- A categorized list of ordinary features and fixes drawn from merged PRs, with links back to the changes.

Review every pending fragment against the selected release commit. Incorporate only changes included in that release, preserve the instructions and leave fragments for unreleased changes pending. Remove incorporated fragments in the same preparation PR that adds the release page. Package changelogs remain separate and are produced by Changesets.

Use `node scripts/prepare-product-release.mjs --version <version> [selected-fragments...]`
from the repository root to prepare local metadata and notes. Existing release
pages require deliberate editing; the helper does not overwrite them, create a
commit or publish a release. Review the selected source, rehearse the exact
candidate and follow the [product release workflow](../docs/docs/developer/product-releases.md)
for approval and publication. The contribution gate only validates release
information; merging a fragment does not publish it.
