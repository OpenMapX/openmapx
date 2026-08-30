---
title: Air-quality release status
description: Stable readiness ledger for the canonical air-quality platform and optional providers.
sidebar_position: 20
---

# Air-quality release status

This ledger separates implemented code from operator-ready release status. Its
rows are checked against the structured front matter in each linked record by
`pnpm check-air-quality-release-gates`.

| Component | Status | Record |
| --- | --- | --- |
| Canonical API and Open-Meteo/OpenAQ providers | shipped | [Base platform](./air-quality-status/base.md) |
| EEA raster | blocked | [EEA raster](./air-quality-status/eea-raster.md) |
| AirNow | blocked | [AirNow](./air-quality-status/airnow.md) |
| EEA ground observations | blocked | [EEA ground](./air-quality-status/eea-ground.md) |
| UK-AIR | blocked | [UK-AIR](./air-quality-status/uk-air.md) |
| ECCC AQHI | blocked | [ECCC](./air-quality-status/eccc.md) |

`blocked` means the optional plan's mandatory STOP condition was reached. No
provider code is present for a blocked row, and the record names the evidence
needed to revisit it. This does not block the shipped canonical platform.
