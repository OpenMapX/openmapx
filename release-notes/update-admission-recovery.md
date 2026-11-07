---
impacts: [operator-action]
---

## What changes

Read-only traffic inspection failures no longer leave an unfinished maintenance
job blocking application updates. Data Manager startup repairs only the exact
legacy traffic failure with no attempted agent operations.

The host CLI adds `services recover-update --operation-key ORIGINAL_OPERATION_KEY`
for an expired standalone service lifecycle that failed at hardlinks. It requires
Data Manager's signed database and private-record non-admission proof before
revoking the unused grant and releasing the original locks.

## Who is affected

Installations whose CLI or admin update is blocked by one of these retained
pre-dispatch failures. Adopted or uncertain operations stay fenced.

## Required action

Upgrade the CLI, running Data Manager and ops-agent before using recovery. Preserve the
original failed receipt and operation key. Follow the recovery section in the
upgrade guide; a blocked installation may need a separately supervised upgrade.
Recovery does not replay work, change containers or create a backup. Continue
with the normal checked CLI or admin update after recovery; selected pins and
source changes alone do not establish a running deployment.
