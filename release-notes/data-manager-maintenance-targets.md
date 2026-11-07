---
impacts: [operator-action]
---

## What changes

Data Manager registers the full built-in service inventory for coordinated
configuration maintenance. Previously, updates containing services such as the
API or operations agent could fail during preparation with “Unregistered
execution role/targets”. Unknown targets and invalid authority still refuse.

## Who is affected

Self-hosted installations using application updates from the admin panel or CLI.

## Required action

Install the corrected Data Manager as part of a qualified release. An update that
already failed remains attached to its original recovery records; this fix does
not replay it or declare it successful. Preserve those records and follow the
supervised recovery guidance in the upgrading documentation before starting
another update. Do not delete guards to unblock the installation.
