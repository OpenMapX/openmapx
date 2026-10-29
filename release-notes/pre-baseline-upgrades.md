---
impacts: [migration, operator-action]
---

## What changes

The Changesets reset does not change runtime behavior. This note retains important upgrade requirements introduced during earlier development so they are not lost when the old queue is cleared.

## Who is affected

Operators upgrading an older development checkout and authors updating extensions built against earlier manifest or attribution contracts. New installations and extensions already using the current contracts need no extra action for the baseline reset.

## Required action

- **Application services:** update ops-agent and data-manager together before promoting a MOTIS dataset. Promotion requires a confirmed stopped or absent runtime; older, unconfirmed stop replies are rejected. The admin updater also requires the running ops-agent and its backup helper to match the selected release. Follow the [host upgrade procedure](../docs/docs/install/upgrading.md) when it reports that a host-side update is required.
- **Older Pelias installations:** Elasticsearch now uses `infra/docker/data/pelias/elasticsearch` instead of the old named volume. An index left only in that volume is not picked up automatically. Follow the [Pelias build procedure](../docs/docs/guides/geocoders.md#pelias), including stopping consumers before rebuilding. Retain the old data until the replacement index has been verified; clearing Changesets does not migrate or delete it.
- **Existing extensions:** use the exact `major.minor` platform protocol format, such as `1.0`, instead of ranges such as `>=1.0.0`. Use canonical contributor/licensing metadata and digest-pinned artifacts; old scalar attribution fields and source-location-only trust are not supported. Validate and rebuild using the [external extension guide](../docs/docs/developer/building-an-external-extension.md) before installing the result.
