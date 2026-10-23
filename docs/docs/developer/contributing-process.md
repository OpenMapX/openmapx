---
title: Contribution process
description: Report issues, complete triage, prepare implementation work, and submit a pull request.
---

# Contribution process

Report what you observed or what should become possible. You do not need to know
the cause, design a fix or estimate the work. Use the
[issue forms](https://github.com/OpenMapX/openmapx/issues/new/choose) for bugs,
features, integrations and tasks; use
[Discussions](https://github.com/OpenMapX/openmapx/discussions) for usage help.
Report vulnerabilities through the
[private security process](https://github.com/OpenMapX/openmapx/blob/main/SECURITY.md).

For bugs, include observed and expected behavior, reproduction attempts, the
running version and relevant environment. Intermittent problems and Unknown are
valid answers. A deployed release-manifest ID or image digest is more useful than
a local checkout SHA that did not build the running images. Mobile app versions,
rough public map areas and provider names can help; do not publish secrets,
personal coordinates or private route history.

Feature requests need a problem and desired outcome; solution ideas are optional.
Integration requests can leave access, rights and attribution details unknown.
Maintainers qualify those before implementation. Tasks describe an objective,
boundaries and completion evidence, with open questions left explicit.

## Triage and labels

Issue types classify the work: **Bug**, **Feature** or **Task**. Conventional PR
titles classify changes. Labels answer a small number of queue/filter questions;
most items need only the labels that convey something useful, often zero to three.
No area assignment or label quota is required.

| Label              | Meaning and next action                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `needs-triage`     | An open issue awaits initial maintainer review. Removing it means reviewed, not scheduled.      |
| `needs-info`       | A specific unanswered question is linked in the issue. The maintainer removes it when answered. |
| `blocked`          | A named, linked prerequisite prevents progress. The maintainer tracks its resolution.           |
| `dependencies`     | Dependency updates or dependency maintenance.                                                   |
| `documentation`    | Documentation content, tooling or workspace dependencies.                                       |
| `integration`      | A new or changed provider, source or backend integration.                                       |
| `ci`               | Continuous integration or GitHub Actions work.                                                  |
| `docker`           | Container images or Docker build/deployment tooling.                                            |
| `good first issue` | A triaged, bounded task with enough guidance for a newcomer.                                    |
| `help wanted`      | Scoped work actively welcoming outside contributions.                                           |

The definitions are versioned in
[`.github/labels.json`](https://github.com/OpenMapX/openmapx/blob/main/.github/labels.json).
Maintainers own classification and these action labels. An arbitrary comment does
not resolve an information request or blocker. Add a new label only when there is
a clear queue/filter consumer; review the taxonomy periodically.

New and reopened issues enter `needs-triage`. Closure removes `needs-triage`,
`needs-info` and `blocked`, while retaining the questions, dependency links and
closure reason in the record. The issue-lifecycle workflow re-reads current state
and makes retries harmless; a later human triage decision takes precedence over
an old reopen event. GitHub does not offer an atomic state-and-label update, so
concurrent transitions are rechecked and repeated changes fail visibly for retry.
If reopening overlaps removal of `needs-info` or `blocked`, the workflow fails with
the affected issue and labels. Check the issue history before restoring them;
automatically restoring them could undo a later human decision.

A monthly and manually triggered drift report lists closed workflow labels,
missing/legacy label definitions and missing issue types. It does not repair
semantic metadata, post comments, close inactive issues or lock discussions.
A successful report run means the report executed, not that every finding is clear.
The repository token may be unable to read organization field definitions; those
checks are explicitly **unverified**, with a maintainer follow-up command in the
workflow warning. No broad token is added for this report.

## Priority, effort and readiness

Priority communicates current ordering, not a delivery promise. Effort is a rough
relative estimate for scoped work, not hours. Maintainers use the existing native
fields and options: Priority **Urgent / High / Medium / Low**, Effort **High /
Medium / Low**. Leave uncertain estimates unset. Start date and Target date are
optional internal planning fields.

The policy is public Priority/Effort and internal dates. Before changing field
visibility or migrating historical labels, read back the actual organization
fields and affected items. Repository source does not establish that hosted
configuration or migration is complete. Preserve native field IDs, options and
history. Do not create parallel priority labels
or duplicate Project fields. Field visibility applies across the organization, so
review other repositories and existing values before changing it.

Before implementation, maintainers refine the verified problem/use case, scope,
acceptance evidence, dependencies and unresolved decisions. Initial triage can
finish while the issue remains in the backlog. See the
[readiness checklist](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#ready-for-implementation).

## PR writing and screenshots

Lead with the problem and resulting behavior, then related work, verification
and release/upgrade impact. Keep factual limits. Small descriptions can combine
prompts or omit empty sections; long experiments belong in collapsed details or
durable public evidence. Do not turn the description into a tool transcript.
The reviewed PR title/body become squash metadata.

Changes that visibly affect the OpenMapX application UI need real inspected screenshots
near their explanation. Documentation-only changes do not require screenshots. Show
comparable, labeled before/after
views for existing behavior or contextual after views for new surfaces. Cover the
relevant viewports and changed states; a short recording can supplement interactions.
Redact personal data and inspect the hosted result after upload.

The installed CLI supports `gh pr create/edit --attach`. Reference attached local
image paths in the body so they are rewritten to hosted URLs. Local paths and
expiring CI artifacts are not delivered evidence. Partial uploads may still create
or update the PR; inspect it before retrying. See
[Contributing](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#descriptions-and-visual-evidence)
for commands and the current verification/release-information policy. Consumer-facing public-package changes need Changesets; important product
changes need [release fragments](https://github.com/OpenMapX/openmapx/blob/main/release-notes/README.md).
A change can need both. Deliberate package batches use the manual
[package release workflow](./package-releases.md); merging a source or version
PR does not publish a release.

AI assistance and authorized coding agents follow the same standards. The submitter
owns understanding, accuracy, verification and follow-up. No mandatory AI footer,
declaration or model inventory is required. Answer honestly about assistance and
attribute quoted AI output where relevant; keep meaningful existing provenance.

Contribution terms remain in the
[CLA](https://github.com/OpenMapX/openmapx/blob/main/CLA.md),
[licensing guide](https://github.com/OpenMapX/openmapx/blob/main/LICENSING.md) and
[Code of Conduct](https://github.com/OpenMapX/openmapx/blob/main/CODE_OF_CONDUCT.md).
