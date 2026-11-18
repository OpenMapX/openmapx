---
impacts: [breaking, migration]
---

## What changes

An update whose API process restarts part-way now continues. The restarted API
runs the update's steps again under the same operation keys: a backup, image
download, maintenance preparation or configuration step that already reached the
operations agent returns its original operation instead of being repeated, and a
step whose request never reached the agent is sent again. Before, such an update
was held for recovery even when its download had finished, or was abandoned with
a conflict after the agent had prepared maintenance.

The operations agent now finishes a configuration maintenance that its job no
longer drives: it records a configuration helper that exited and reopens other
operations without waiting for the job, settles data-manager's configuration
fence again when data-manager did not answer, releases the services of a
maintenance that settled just before a restart, and gives back a prepared
maintenance whose deadline passed before anything was applied, so an update
that never started applying no longer needs its job cancelled after the
deadline to close. When
data-manager refuses the fence settlement for good, the agent stops sending it
and marks the maintenance as needing recovery. `openmapx control resolve`
refuses a maintenance the agent still drives (preparing, prepared or applying),
settles the fence with the outcome the agent already recorded, and ends the
maintenance when data-manager has no such fence or settled it otherwise.

A configuration change applied directly from the admin panel or API (settings,
credentials, integration bindings, platform changes, migrations) whose API
process restarts before the new settings were saved ends without the change and
gives back any maintenance it had prepared; one that had saved them finishes
applying them. A queued job (service updates, releases, extension installs)
continues its configuration change in either case.

An administrative job whose agent operation was interrupted by an agent restart
now ends failed with the error code `recovery_required` instead of staying
running. The agent keeps that operation's services held until an operator
records the outcome with `openmapx control resolve`.

The API database gains an `admin_job.protocol` column (migration `0066`) that
holds the job runner's own state. The migration copies nothing: install from an
empty database, as the update-system replacement requires.

Configuration results in the administration API no longer contain
`publisherCleanupFailed`; the publisher it described was removed with the sealed
configuration queue, so the field was always `false`.

## Who is affected

Operators who update through the admin panel or `openmapx system update`, and
clients of the administration API that read `publisherCleanupFailed` from
configuration results (integration credentials and bindings, transit feed
credentials and configuration job results).

## Required action

None for updates. API clients should stop reading `publisherCleanupFailed`. A job
that ends with `recovery_required` needs `openmapx control status` and
`openmapx control resolve` as described in the services administration guide.
