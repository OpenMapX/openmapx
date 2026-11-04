---
impacts: [breaking]
---

## What changes

Transit navigation keeps the selected connection until the rider explicitly chooses an alternative. Riders confirm boarding and alighting, with a short undo window. Schedule drift and GPS disagreement no longer automatically switch services.

The native navigation session schema changes to version 2. Stored version 1 sessions, including active ground-navigation sessions, are discarded rather than migrated.

## Who is affected

People using transit navigation in the browser or installed app, and anyone upgrading an installed app with an active navigation session.

## Required action

End navigation before upgrading the installed app, then select the journey and start navigation again. Use the updated installed app for the new transit rider controls and background ownership. There is no migration or recovery of an old active session; saved places and planned journeys are unaffected.
