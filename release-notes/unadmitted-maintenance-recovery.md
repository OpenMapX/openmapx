---
impacts: [operator-action]
---

## What changes

Cancelling an application update can close a preparation that Data Manager took
the maintenance grant for but never admitted. Once the original deadline has
passed, cancellation settles it only after Data Manager and the operations agent
confirm that nothing was admitted or changed. The job finishes as failed, keeps
its receipt, releases its ownership and discards its prepared configuration
candidate. It does not resume the update, replace containers or make a backup.

## Who is affected

Installations with an application update that stays at preparation with
`recovery_required` while the previous containers keep running. Admitted or
uncertain work stays pending.

## Required action

Cancel the original job in Activity with a full administrator session, then
start a fresh checked update. Do not delete locks, clear database flags or
replay the preparation grant; see the upgrading guide.
