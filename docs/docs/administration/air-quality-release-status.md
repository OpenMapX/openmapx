---
title: Air-quality release status
description: Stable readiness ledger for the canonical air-quality platform and optional providers.
sidebar_position: 20
---

# Air-quality release status

Use the component records to distinguish shipped source from optional providers
that stopped at a source-contract or permission gate. `shipped` does not mean
that credentials, quota, source policy or live availability have been verified
for your deployment. The saved source reviews are dated 30 August 2026.

`pnpm check-air-quality-release-gates` checks matrix/record consistency, source
paths, fixture metadata and review age. It does not call live providers, verify
new permissions or approve a blocked provider.

| Component                                     | Status  | Record                                           |
| --------------------------------------------- | ------- | ------------------------------------------------ |
| Canonical API and Open-Meteo/OpenAQ providers | shipped | [Base platform](./air-quality-status/base.md)    |
| EEA raster                                    | blocked | [EEA raster](./air-quality-status/eea-raster.md) |
| AirNow                                        | blocked | [AirNow](./air-quality-status/airnow.md)         |
| EEA ground observations                       | blocked | [EEA ground](./air-quality-status/eea-ground.md) |
| UK-AIR                                        | shipped | [UK-AIR](./air-quality-status/uk-air.md)         |
| ECCC named-community evidence                 | shipped | [ECCC](./air-quality-status/eccc.md)             |

`blocked` means a mandatory source-contract or legal STOP condition was reached. No
provider code is present for a blocked row, and the record names the evidence
needed to revisit it. This does not block the shipped canonical platform.
The ECCC shipped row is intentionally secondary evidence: it does not claim a
local AQHI method or community coverage relationship.
