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
