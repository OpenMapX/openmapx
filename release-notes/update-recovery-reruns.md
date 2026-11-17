---
impacts: [breaking]
---

## What changes

An update whose API process restarts part-way now continues. The restarted API
runs the update's steps again under the same operation keys: a backup, image
download, maintenance preparation or configuration step that already reached the
operations agent returns its original operation instead of being repeated, and a
step whose request never reached the agent is sent again. Before, such an update
was held for recovery even when its download had finished, or was abandoned with
a conflict after the agent had prepared maintenance.

Configuration results in the administration API no longer contain
`publisherCleanupFailed`; the publisher it described was removed with the sealed
configuration queue, so the field was always `false`.

## Who is affected

Operators who update through the admin panel or `openmapx system update`, and
clients of the administration API that read `publisherCleanupFailed` from
configuration results (integration credentials and bindings, transit feed
credentials and configuration job results).

## Required action

None for updates. API clients should stop reading `publisherCleanupFailed`.
