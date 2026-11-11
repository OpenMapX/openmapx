---
impacts: [breaking, operator-action]
---

## What changes

Integration administration now validates mutation inputs strictly. Credential source
labels reflect the actual resolver, including environment and config-file overrides of
vault values.

Trusted configuration operation results now distinguish committed, not committed and
uncertain outcomes, with separate follow-up and cleanup evidence. An accepted job is
not proof of application success. API and ops-agent must use matching contracts. Old
successful configuration-result journal records can fail strict validation; there is
no compatibility reader or journal migration. All five full-snapshot apply kinds
now require an expected current host revision observed before payload preparation.
Missing conditions are rejected. A completed competing writer produces a conflict
without retrying or overwriting its generation.

Pending browser mutations retain their original server and view ownership when the UI
changes.

CLI and ops-agent configuration writers share a fence on the same local POSIX
filesystem under the same stack UID. This does not provide a distributed transaction
across PostgreSQL, filesystem activation and runtime reload. Incomplete or uncertain
recovery requires reconciliation rather than an automatic mutation retry.

## Who is affected

Self-hosted operators upgrading API, ops-agent and the stack-management CLI together,
and clients interpreting trusted job results.
The writer fence targets cooperating Linux/macOS writers on local storage; Windows
is rejected and network filesystems are not qualified. Local macOS checks do not
establish deployed Linux, filesystem or UID compatibility.

## Required action

Inspect final apply and recovery evidence.
Before upgrading, stop configuration writers and inspect retained jobs and claims;
preserve evidence and reconcile incomplete work. Plan explicit operator handling of
incompatible retained configuration results before restarting with matching components.
No automatic journal conversion or deletion is supplied.

A killed writer can leave `.trusted-config-writer` in the shared infra directory.
Stop **all** writers before inspecting and, only after confirming abandonment, removing
that lock. There is no stale-lock stealing, PID-based reclamation or automatic recovery;
never remove a lock while another writer might still hold it.
