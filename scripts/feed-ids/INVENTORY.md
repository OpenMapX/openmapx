# Feed-ID migration — source inventory & scope decisions

Ground truth for the generator (Task 4) and the hand-curation (Task 5).
`providerCountry` is read from each integration's `manifest.json` dataSources.

## A. poi-ingest sources (DB-backed — need table drop + re-ingest)

Enumerated from `declarePoiSources()` in each integration.

### ev-charging (`integrations/ev-charging/poi-sources.ts`)
| oldId | oldPrefix | country | proposed newId | proposed operator | notes |
|---|---|---|---|---|---|
| bnetza-ev | bnetza: | DE | de-bnetza | bnetza | national registry (BNetzA) |
| switzerland-ev | swiss-sfoe: | CH | ch-sfoe | sfoe | national (ich-tanke / SFOE) |
| netherlands-ev | nl-dotnl: | NL | nl-dotnl | dotnl | national (DOT-NL/NDW) |

### parking (`integrations/parking/poi-sources.ts`) — 35 sources incl. osm
| oldId | oldPrefix | country | proposed newId | subdivision? | operator |
|---|---|---|---|---|---|
| utmc-newcastle | utmc: | GB | gb-eng-utmc | eng | utmc (Newcastle UTMC) |
| brussels-be | brussels: | BE | be-bru-brussels | bru | brussels |
| madrid-es | madrid: | ES | es-md-madrid | md | madrid |
| nrw-mobidrom-parking | nrw: | DE | de-nw-mobidrom | nw | mobidrom (NRW mobidrom parking) |
| nrw-mobidrom-pr | nrw-pr: | DE | de-nw-mobidrom-pr | nw | mobidrom, stream=pr (park+ride) |
| apag | apag: | DE | de-apag | (none — operator) | apag (Aachen APAG operator, national-ish) |
| apag-mobidrom | apag-mobidrom: | DE | de-apag-mobidrom | — | apag, stream=mobidrom |
| apcoa | apcoa: | DE | de-apcoa | — | apcoa (operator) |
| parkapi-v3 | parkapi-v3: | DE | de-parkapi-v3 | — | parkapi, stream=v3 |
| parkapi-v2 | parkapi-v2: | DE | de-parkapi-v2 | — | parkapi, stream=v2 |
| basel-ch | basel: | CH | ch-bs-basel | bs | basel |
| copenhagen-dk | copenhagen: | DK | dk-84-copenhagen | 84 | copenhagen (ISO 3166-2 DK-84 Hovedstaden) |
| florence-it | florence: | IT | it-52-florence | 52 | florence (IT-52 Toscana) |
| ghent-be | ghent: | BE | be-vlg-ghent | vlg | ghent |
| vienna-at | vienna: | AT | at-9-vienna | 9 | vienna (AT-9 Wien) |
| bnls-fr | bnls: | FR | fr-bnls | — | bnls (Besançon? verify — operator/aggregator) |
| barcelona-es | barcelona: | ES | es-ct-barcelona | ct | barcelona (ES-CT Cataluña) |
| cita-lu | cita-lu: | LU | lu-cita | — | cita |
| ndw-truck-nl | ndw-truck: | NL | nl-ndw-truck | — | ndw, stream=truck |
| opendatahub-it | odh: | IT | it-32-opendatahub | 32 | opendatahub (IT-32 Trentino-Alto Adige / South Tyrol) |
| opentransportdata-ch-parking | otdch-parking: | CH | ch-otd | — | otd (opentransportdata.swiss) |
| autobahn-de | autobahn: | DE | de-autobahn | — | autobahn (national motorway) |
| db-bahnpark | db-bahnpark: | DE | de-dbbahnpark | — | dbbahnpark (national rail parking) |
| nsw-au | nsw: | AU | au-nsw | nsw | nsw (NSW transport) |
| singapore | sg: | SG | sg-lta | — | lta? (verify — SG parking; operator LTA) |
| rdw-nl | rdw: | NL | nl-rdw | — | rdw (national vehicle authority) |
| goldbeck | goldbeck: | DE | de-goldbeck | — | goldbeck (operator) |
| braunschweig-de | braunschweig: | DE | de-ni-braunschweig | ni | braunschweig (DE-NI Niedersachsen) |
| bremen-de | bremen: | DE | de-hb-bremen | hb | bremen |
| duesseldorf-de | duesseldorf: | DE | de-nw-duesseldorf | nw | duesseldorf |
| salzburg-at | salzburg: | AT | at-5-salzburg | 5 | salzburg (AT-5) |
| bielefeld-de | bielefeld: | DE | de-nw-bielefeld | nw | bielefeld |
| bamberg-de | bamberg: | DE | de-by-bamberg | by | bamberg (DE-BY Bayern) |
| trier-de | trier: | DE | de-rp-trier | rp | trier (DE-RP Rheinland-Pfalz) |
| potsdam-de | potsdam: | DE | de-bb-potsdam | bb | potsdam (DE-BB Brandenburg) |
| osm | osm: | UK | osm | — | GLOBAL — STAYS BARE (migrate:false) |

## B. manifest-only national overlays (migrate manifest sourceId + strings only — NO table)
| integration | oldSourceId | country | proposed newId | notes |
|---|---|---|---|---|
| ev-charging | afdc | US | us-afdc | national (AFDC/NREL live API) |
| ev-charging | nobil | NO | no-nobil | national (NOBIL live API) |
| ev-charging | france-irve | FR | fr-irve | national (IRVE registry) |
| fuel | tankerkoenig | DE | de-tankerkoenig | national fuel-price overlay |

## C. GLOBALS — stay bare (migrate:false, parts:null)
- ev-charging: `ocm` (OpenChargeMap, global; providerCountry AU is org locale), `osm`, `opendatasoft` (global data platform)
- parking: `osm`
- (any other manifest sourceId across the ~85 integrations NOT listed in A/B stays untouched)

## Notes / verify-in-Task-5
- `bnls-fr`, `singapore`, `cita-lu`, `opentransportdata-ch-parking` operator slugs are best-effort — confirm.
- ISO 3166-2 subdivision codes above are proposed; verify each against the source's `coverage` bbox in poi-sources.ts.
- `apag`/`apag-mobidrom`/`apcoa`/`goldbeck`/`parkapi-*` are commercial operators, not city feeds → country-level, no subdivision.
