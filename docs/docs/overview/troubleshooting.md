---
title: Troubleshooting and help
description: Resolve common map problems and collect useful information for a support request.
sidebar_position: 4
---

# Troubleshooting and help

OpenMapX instances can use different providers and regional datasets. When
reporting a problem, identify the instance and the feature that failed.

## Search returns no results

Try coordinates or a nearby larger place to check whether the problem is limited
to one query. Name and address search needs a configured geocoder. A working map
does not establish that a geocoder is available, and provider coverage varies.

See [Search](../features/search.md). Instance operators can check
[integration status and configuration](../administration/integrations-administration.md)
and the [geocoder guide](../guides/geocoders.md).

## No route or transit journey is available

Check the start, destination, travel mode, and departure date. Try a shorter
journey inside the provider's coverage. A map can display roads or stops that
the selected routing or transit provider cannot use.

Scheduled departures and live predictions are different. A missing prediction
does not mean a service is cancelled. See [Directions](../features/directions.md),
[Public transit](../features/public-transit.md), and the operator's
[coverage and freshness guide](../administration/coverage-freshness.md).

## A layer is empty

Check its legend and coverage, then try another map position or zoom level.
Some layers appear only at suitable zooms or where their provider has data.
Operators can check the integration's health and credentials in the admin panel.
See [Map layers](../features/map-layers.md).

## Location or voice controls do not work

Check the browser's location or microphone permission for the instance. Device
settings can also block access. Browser support and a secure connection affect
which controls are available. You can enter a start location and type a search
without granting either permission.

Voice input may use the browser vendor's speech service. Review the
[search privacy notes](../features/search.md) before enabling it.

## Downloaded maps are unavailable offline

While online, open **Offline maps** in the main menu and check each area's
status. Preparation and download must finish before an area is ready. The area
must cover the place and zoom levels you need.

Downloads belong to the current browser and device. Clearing site data can remove
them, along with other local data such as signed-out vehicles and reporting keys.
Check [Offline maps](../features/offline-maps.md) for supported storage and route
continuation before deleting or downloading an area again.

## An account connection stops working

For Dawarich, follow the error-specific steps in
[Personal timeline](../features/personal-timeline.md#errors-and-recovery).
An unavailable managed instance usually needs operator recovery; repeatedly
replacing the API key will not repair it.

For reviews, keep a backup of your signing key before changing its protection or
clearing browser data. Read [Reviews](../features/reviews.md) for the limits of
key recovery.

## Ask for help or report a bug

Use [GitHub Discussions](https://github.com/OpenMapX/openmapx/discussions) for
usage and configuration questions. Use the
[issue forms](https://github.com/OpenMapX/openmapx/issues/new/choose) for a
reproducible problem or feature request. Include:

- The instance URL and, if known, its version or commit.
- The browser, operating system, and device type.
- Steps to reproduce, the expected result, and the actual result.
- The affected place, region, travel mode, or layer, using public or synthetic
  examples where possible.
- Relevant error messages. Operators can add service and integration health
  information from the [monitoring guide](../administration/monitoring.md).

Remove passwords, tokens, cookies, private share links, and personal locations
from logs and screenshots. Report security vulnerabilities through the
[private disclosure process](https://github.com/OpenMapX/openmapx/security/policy).
