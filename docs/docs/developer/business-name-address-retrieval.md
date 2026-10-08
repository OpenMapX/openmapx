---
title: Berlin business name/address retrieval investigation
description: Source identities, reusable regressions and a bounded local lexical evaluation for issue 430.
---

# Business name/address retrieval: decision and next steps

**2026-10-08: GO for staged local lexical development over existing Overture
data; NO-GO for production adoption yet.** The disposable PostgreSQL probe
retrieves Moch without another ingestion source. Combined with saved geocoder
results, verified Hit@3 rises **4/9→8/9**. A mall association gap, three weak
address-query Enter decisions, unknown deployed generations and unmeasured
regional/cold performance remain gates. No application provider/schema,
production data/cache/configuration, ingestion or deployment changed.

## Reusable inputs and external evidence

The [regression corpus](https://github.com/OpenMapX/openmapx/tree/main/scripts/discovery-eval/business-name-address)
keeps 13 versioned queries, 52 distinct raw/adapter candidate projections, reviewed
source identities, real-adapter checks and a current-checkout replay. Its README
provides commands, recapture conditions and rights. Inputs were captured on
2026-10-07; these are not today's live provider results.

Dated dropdowns/status snapshots, timings, repeated per-query lists, historical
rank/Enter outputs and the original report are in the [October 7 capture archive](https://gist.github.com/Medformatik/c36d8b8f44c88971277659512a533a51/8b33cd9238ba743f54f3235f2831470cf3bb5972).
The throwaway code, 3,255-row source projection, SQL plans/costs, current-main
replay/composition and reproduction instructions are in the [October 8 lexical
probe archive](https://gist.github.com/Medformatik/3fdd91df857e72bf3a492836324f3c69/4f458cce9bdcce34cb335881e91c56a5bbf781e1). Both commit permalinks have checksum manifests and
attribution. Full raw operator files/screenshots/test logs were temporary; no
public durable archive is claimed for them. Prior Git history is preserved.

| Input/condition                  | Pin or limitation                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial source/replay            | Main `3c80939d26a09f131b16d849895255436b5e5798`                                                                                                                                                         |
| Current-main replay/composition  | Freshly fetched `fe6b7969979ae024655e38d3b4f605295e757f93`, clean source export; #432 included; #429/#438 evaluated separately below                                                                    |
| Captured query context           | EN, Berlin `[13.416,52.5194]`, zoom 15; upstream rounded `[13.42,52.52]`, MapTiler limit 6/autocomplete/types including POI, aggregate limit 8                                                          |
| Public deployment/provider/cache | Unknown deployment SHA, provider generation/chain, OSM extract, active Overture generation and cache history; authenticated status 401. Enabled registry does not prove health/data/capability bindings |
| OSM                              | API bbox/direct versioned elements, not deployed data or a regional PBF; Overpass failed before API fallback                                                                                            |
| Overture                         | Dated release `2026-09-23.1`, bbox `[13.408,52.513,13.426,52.527]`, 3,255 rows; export SHA256 `a9ec6402ecd390d6200151ace4d5a5a7106d1ca8641652e19dd336211684ba93`; STAC 403, explicit release readable   |
| Live UI                          | Separate dated anonymous capture, 1280×800/DPR1/dark/fixed Berlin camera; 13 lists/two Enter observations. No prototype UI or application-only comparison                                               |

## Identity and source presence

[Official Moch](https://www.edeka.de/maerkte/408935/) verifies Grunerstr. 20,
10179 Berlin, phone +493024045625; rechecked 2026-10-08. Its point is a listing
location, not a surveyed entrance. Shared mall address/proximity/brand cannot
establish exact tenant identity.

| Entity                    | Evidence and judgment                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moch/Overture             | **Present, verified listing:** GERS `035b544e-40f5-4ce0-a06f-1c9032ded028` v13, matching name/address/phone; Meta 194804870560113 updated2026-08-24. Operating status null=unknown                                                                                                                                     |
| OSM EDEKA room            | **Present, operator unresolved:** way 1204762785 v3, supermarket/indoor/level −1/name EDEKA; no operator/contact/street/number. Exact Moch attributes absent in inspected mall records, not globally absent OSM                                                                                                        |
| Alexanderstraße 25 result | MapTiler `poi.39267497` references that same way, which does not assert this address; Nominatim gives Alexanderstraße without house number. **Address inference/identity ambiguity**, neither a verified other branch nor confirmed Moch                                                                               |
| MediaMarkt                | OSM node 322490364 v24 at Grunerstraße 20, branch-specific website. GERS `bfbe5e1d-7db5-482e-8772-f53959dde008` v9 and `81270f18-8f0b-48a9-ae69-31d4ef96cdd5` v8 describe the mall branch: duplicate judgment must retain IDs/credits. Espressobar `337b556d-d0d0-4c38-a81b-c92bc326eba1` is a separately named tenant |
| Schaaf alternative        | Dated official profile 407497, Schillingstr. 2/phone +493023458611, OSM node 9154787137 v13 and GERS `a56cd442-edcf-4d26-98c1-9c70de50f1d7` v11 agree. Raw MapTiler references the node but formats Singerstraße 121. Official profile recheck 404 on October 8 leaves current operation unknown, not proven closed    |
| REWE                      | Dated official profile 1350030/OSM node 348000444 v29 verify Invalidenstraße 158. Overture **unknown**, outside inspected bbox                                                                                                                                                                                         |
| Deployed copies           | **Unknown** for every source-presence judgment; no production DB access                                                                                                                                                                                                                                                |

Provenance/licenses remain separate from code licensing: MapTiler terms, OSM
ODbL, Overture/Meta CDLA-Permissive 2.0, Foursquare Apache 2.0 and contributor CC0
where recorded. No ATP coverage claim/new-source requirement. If an intended
generation lacks Moch, inspect release/import filters before proposing enrichment.

## Separate retrieval, adaptation, ranking and selection

Raw MapTiler and independently captured adapted rows have the same 78 candidates
and ID order across 13 queries: the adapter does not cause Moch's omission. All
aggregate replies were empty/partial: unavailable retrieval, not source absence.
Initial combined 78→ranked 65 losses happen after retrieval. The OSM index covers
aliases/codes/acronyms, skipping ordinary business names; Overture exposes category
search rather than named-business candidates; Overpass matches whole query against
name without address decomposition. Code: `integrations/geocoding-maptiler/provider.ts`,
`services/data-manager/src/jobs/search-index/{terms,extract}.ts`,
`integrations/poi-overture/index.ts`, `packages/core/src/utils/overpass.service.ts`,
`integrations/search-suggestions/orchestrator.ts`, shared `suggestionRanking.ts`.

| Offline layer/run                         | Verified Hit@3                 | Interpretation                                                                                                                                                   |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved raw/adapted/combined                | 4/9                            | Five Moch variants have no confirmed exact tenant; three have unresolved possible matches                                                                        |
| Same pool, initial/current-main ranker    | 4/9→4/9                        | #432 puts Berlin MediaMarkt above Rijswijk; Enter becomes weak/search instead of opening Rijswijk. EDEKA Alexa also becomes weak/search. Total 65 rows unchanged |
| Local lexical candidates                  | 7/8 inspected-source positives | Four Moch variants, two MediaMarkt variants and Schaaf; REWE outside bbox excluded from this denominator, not called absent                                      |
| Lexical+saved adapter/current-main ranked | 8/9                            | Combined 90→ranked 75; EDEKA Alexa stays missing. Both lexical negatives return 0; geocoder address/area fallback remains                                        |

Moch ranks first for four retrieved variants. Enter opens it for `EDEKA Moch`,
but remains weak/search for `EDEKA Moch Grunerstraße 20`, `EDEKA Grunerstraße 20
Berlin` and `EDEKA Grunerstraße`: selection-policy gaps despite retrieval success.
Explicit Alexanderstraße still opens the unresolved provider row and stays
unjudged. Offline outputs are not observed new live navigation.

## Separately pinned #429/#438 comparison

[PR #438](https://github.com/OpenMapX/openmapx/pull/438) head
`dadd03d5339ad65b64de7a8240054d3befacd10c` was evaluated against its verified
ancestor `5f07b70967319b4b2c86769b542b551b93f98e02`, using clean task-owned source
exports and identical input pools. Fresh main
`9b212363ba891e97ac4a19c080a10bbc0e343cbd` produces the same traces as that base.
No other task's branch/worktree was changed; #438 is unmerged in this comparison.

Geocoder candidates stay78 but ranked rows rise65→78; lexical+geocoder candidates
stay90 but ranked rows rise75→90. All candidates survive shared ranking in these
small pools. Verified Hit@3 stays4/9 and8/9 respectively; every Enter action is
unchanged. This is deduplication preservation, not new upstream/local retrieval.
The two MediaMarkt GERS rows and MapTiler branch now remain separate until
corroborated cross-source identity. Duplicate handling remains an integration
gate; the missing Alexa association and three weak Moch address selections remain.
The archive contains separate base/head/current-main traces and recomputed counts.

## Local probe and bounded integration rules

Throwaway SQL normalizes case/diacritics/German street spellings; decomposes name
and same-address street requirements, a separate house-number field and separate
locality tokens; permits only ≥3-character final
name prefixes; excludes permanent closure while retaining unknown status. Wrong
operator/house/city cannot fall through to that business. Whole/leading business
names precede tenants merely mentioning them. An initial Espressobar-first result
was reproduced by a failing DB check and corrected. GERS candidates remain distinct
before ranking: no invented mall alias or cross-source link. A review reproduced
postcode-as-house substitution; separate address roles now reject it and region-as-city
substitution. Trailing single house numbers/suffixes are supported; ranges and
general address parsing,
brand+city without street, multilingual matching and mall associations remain incomplete.

| Measured local cost | Result/conditions                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database            | PostgreSQL 18.6/PostGIS 3.6.4/aarch64; image `ghcr.io/baosystems/postgis@sha256:f5d625d4263fd9e9a90033951619c2707734a04abbce41ade91522f3428e42d9`; network disabled, own tmpfs 256 MiB, 2 CPU/512 MiB |
| Import/index build  | 1.60s/0.16s including Docker/psql overhead; 3,255 places+3,255 addresses                                                                                                                              |
| Table/index bytes   | 2,392,064/1,056,768 across both tables                                                                                                                                                                |
| Memory              | Whole-container cgroup peak 300,068,864 bytes over probe session, not process peak RSS                                                                                                                |
| Warm SQL p95        | 0.205–3.396ms per-query range; 20 EXPLAIN ANALYZE/BUFFERS repeats/query, nearest-rank p95; warmed by import/earlier calls                                                                             |
| Warm command p95    | 67.8–94.0ms including Docker exec/psql startup; not application/provider latency                                                                                                                      |
| Plans/cold/scale    | Selective bitmap indexes; broad EDEKA includes sequential scans. LIMIT caps candidates, not scanned rows. OS-cold/regional/production costs unknown; shared host load uncontrolled                    |

Follow-up: an isolated regional lexical index over existing imports, retaining the
specialized alias index; acquire≤30/output≤8 (combined API 8/hard 20/UI 10), one SQL
operation/300ms DB deadline within existing 1,200 ms provider deadline, no remote
candidate enrichment. Proposed provider p95 cold≤500ms/warm≤150ms and interaction
cold≤5000ms/warm≤2000ms remain **unproven**. Cache by release/index epoch/query/
language/region/proximity; test both orders/cold/warm. Unready/timeout reports
partial/unavailable with geocoder fallback; do not cache failures as authoritative misses.

Use existing `SearchSuggestion`: `id=overture:<GERS>`, `ids.overture`, actual
source name/address/coordinates, provider, matched name, neutral importance. Keep
structured provenance/release/address in audit rows, credits in attributions;
selection requires `poi-overture` resolver/PostGIS ready on the same generation.
Brand IDs/proximity/shared addresses/switchboards cannot alone merge branches.
Conflicts stay separate; verified links retain IDs/credits. Missing selection
must not silently substitute another branch.

## Validation, admin inspection and remaining work

Compact corpus: 14 real-adapter/term-extractor checks. Probe: 10 normalization/SQL
checks plus 15 transactional DB checks for identities, negatives, abbreviations,
boundaries, branches/tenants, permanent/unknown closure, remote address, same-address
consistency, postcode/region role confusion, caps, injection and timeout. Focused/types/lint/docs/CI recorded in PR.

Existing admin workflows expose Overture release/region/counts and search-index
epoch/publication/staleness. Fingerprint is available in authenticated status,
not the card summary. Ready alias-index/healthy Overture does not establish business
lexical coverage. Documentation corrected; no admin behavior/shared caches changed.

Next: review separately owned #438/#429;
address verified name+address Enter intent while retaining unknown-identity guards;
resolve or retain the EDEKA Alexa gap; inspect intended generation/resolver and
measure regional/cold/warm resource costs. Promotion requires 9/9 verified positives
in top 3, zero wrong-branch/false exact negatives, branch preservation and controlled
fallback/latency. No production feature, embeddings, ATP pipeline, global rollout,
merge or deployment is authorized by this evaluation.
