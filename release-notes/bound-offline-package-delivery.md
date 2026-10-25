---
impacts: [security, operator-action]
---

## What changes

Offline map archive delivery now limits concurrent streams and rolling response bytes at both the
public API and data-manager boundaries. Full and resumed downloads remain streaming and Range-safe.

## Who is affected

Deployments that expose local OpenMapX offline-package downloads receive the new per-process limits.

## Required action

No action is required for a single-process deployment. Operators running multiple API or
data-manager replicas should also enforce deployment-wide concurrency and egress limits at the edge
or CDN because the built-in counters are intentionally process-local.
