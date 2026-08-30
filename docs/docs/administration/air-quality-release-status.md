---
title: Air-quality release status
description: Stable readiness ledger for the canonical air-quality platform and optional providers.
sidebar_position: 20
---

# Air-quality release status

This ledger separates implemented code from operator-ready release status. A
component stays `deferred` until its implementation plan's closeout has passed
tests, policy/license review, documentation, and deployment evidence.

| Component | Status | Record |
| --- | --- | --- |
| Canonical API and Open-Meteo/OpenAQ providers | deferred | [Base platform](./air-quality-status/base.md) |
| EEA raster | deferred | [EEA raster](./air-quality-status/eea-raster.md) |
| AirNow | deferred | [AirNow](./air-quality-status/airnow.md) |
| EEA ground observations | deferred | [EEA ground](./air-quality-status/eea-ground.md) |
| UK-AIR | deferred | [UK-AIR](./air-quality-status/uk-air.md) |
| ECCC AQHI | deferred | [ECCC](./air-quality-status/eccc.md) |

`deferred` is intentional: it is not a claim that the component is absent, only
that the full release gate has not yet been closed.
