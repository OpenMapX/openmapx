---
title: Repository protection and recovery
---

# Repository protection and recovery

The `main protection` repository ruleset (ID `17765533`) targets the default
branch. This policy replaces the earlier direct-administrator-push convention.

## Normal contribution path

All routine changes use a PR, including maintainer changes. While OpenMapX has
one active maintainer, zero independent approvals are required. Code-owner and
last-push approvals are not mandatory. Maintainers remain responsible for
understanding changes and reviewing their evidence.

Resolve code-review threads after fixing the finding, explaining rejection or
agreeing on a follow-up. Do not resolve all threads merely to unblock merging.
Only squash merges are allowed. The PR title and body become the default
squash commit message; review both and preserve attribution and trailers.

Required checks use the loose policy: branches do not need updating after each
merge to `main`. There is no merge queue. Post-merge CI checks the combined
result and gates image publication. Repair a failing `main` before continuing
unrelated merges.

## Required checks

Keep these exact contexts bound to their observed producing app,
`github-actions` (app ID `15368`):

- `lint / types / test`
- `Validate conventional commit title`
- `Analyze (javascript-typescript)`
- `review dependencies`
- `check / record signature`

All five producers were verified on human and Dependabot PR heads on
17 October 2026. Recheck real check runs before renaming a context or changing
its app binding. The PR-title workflow's auxiliary commit status does not
replace the required job. App binding identifies GitHub Actions, not a unique
workflow, so review workflow changes and avoid duplicate job names.

Preserve linear history, deletion protection and force-push protection.
CodeQL analysis completion and alert-severity blocking are distinct controls.
Readback on 18 October 2026 confirmed an active native `code_scanning` rule
in this ruleset with tool `CodeQL`, `security_alerts_threshold: high_or_higher`
and `alerts_threshold: none`. The app-bound `Analyze (javascript-typescript)`
context remains independently required; successful analysis alone does not
establish that its findings satisfy the native rule.

Applicable new High/Critical security findings in changed lines block merging;
all lines identified by an alert must be in the PR diff. Existing out-of-diff
backlog and Medium/Low findings remain subject to triage, rather than a
universal clean-scan requirement. Do not bulk-dismiss alerts to establish a
clean baseline.

Hosted verification on 18 October 2026 observed a High-finding PR blocked
after successful analysis. In-progress analysis also blocked merging. A
Medium-only PR had successful analysis and checks and a `CLEAN` merge state
despite existing out-of-diff findings.

[GitHub documents](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection)
that an unconfigured required tool also blocks merging. No missing-tool trial
was performed; this is documented platform behavior, not an observed case.
Missing or unfinished required analysis must not be treated as approval:
retain both the app-bound completion check and the native rule, and use only
the incident-specific recovery procedure below when necessary.

## Actions and security reporting

Actions must use full commit-SHA references, including GitHub-owned and
organization-owned Actions. There is no additional Action allowlist. Review
Action selection and retain automated pin-update PRs. Local same-checkout
reusable workflows keep local paths. GitHub's native policy still permits
tagged external reusable workflows; project review must require full SHAs for
those too. Pinning selects code; it does not prove that code is safe.

Default workflow tokens have read permissions. Declare additional permissions
only in jobs that need them. The approved [package version-PR configuration](./package-releases.md)
allows Actions PR creation/approval while preserving the read-only default.
Maintainers own activation and live readback of the organization/repository setting.
Only the manual version job gets contents/PR write; it never approves or merges.
Bot-created PR CI still requires maintainer approve-and-run. Keep privileged
title/CLA workflows metadata-only.

Applicable fork CI from first-time contributors requires approval; returning
contributors use normal automatic runs. Dependabot patch/minor updates may
auto-merge after applicable checks and merge conditions pass; major updates
remain manual. Bot authorship does not waive review-thread resolution or the
release-information policy applicable to a change.

Private vulnerability reporting is enabled. Keep the public reporting route
and email fallback in the repository's
[security policy](https://github.com/OpenMapX/openmapx/security/policy)
discoverable. Verify the reporter-facing entry separately from administrator
advisory-creation access, without submitting a test report or sending email
solely to check discovery.

Native release immutability protects published GitHub release assets and their
tags, including prereleases. Attach every intended asset while the release is
a draft. Artifact corrections require a new version; factual title/note edits
remain possible. Registry channels and package publishing have separate
controls.

## Emergency recovery

Administrator bypass is restricted to PRs. It is not a routine direct-push
path. Use it for a concrete incident, not to avoid a slow check or ordinary
review work.

1. Keep the repair in a PR. Record the incident, why normal checks cannot
   safely complete, checks performed and expected effect.
2. Obtain explicit incident-specific maintainer authorization before an agent
   uses bypass. General implementation authorization does not grant it.
3. Use only the necessary PR bypass. Do not remove required checks, widen
   bypass actors or force-push `main` as an improvised workaround.
4. Verify the resulting source and post-merge validation, then record the
   outcome and agreed follow-up in the PR.

For a misconfigured required context, first compare real names/producers and
the ruleset. Correct only the evidenced error, preserve before/after state and
read back the result. Do not create an unprotected interval to make progress.

## Readback and maintenance

The CLI can configure and read back these repository settings:

```bash
gh api repos/OpenMapX/openmapx/rulesets/17765533
gh api repos/OpenMapX/openmapx/rules/branches/main
gh api repos/OpenMapX/openmapx/actions/permissions
gh api repos/OpenMapX/openmapx/actions/permissions/workflow
gh api repos/OpenMapX/openmapx/actions/permissions/fork-pr-contributor-approval
gh api repos/OpenMapX/openmapx/private-vulnerability-reporting
gh api repos/OpenMapX/openmapx/immutable-releases
gh api repos/OpenMapX/openmapx --jq '{allow_merge_commit, allow_rebase_merge, allow_squash_merge, squash_merge_commit_title, squash_merge_commit_message}'
```

Read back API state after every change. Check required contexts on real PRs and
the public reporting entry without submitting anything. Settings readback
alone does not prove every fork, bot or generated-release workflow works;
record those acceptance limits in execution receipts.

Review settings drift when workflows or release automation change. Revisit
mandatory independent approvals when a second active maintainer joins.
