# Semantic Taxonomy Evaluation

- Model: `qwen3-embedding:0.6b`
- Model digest: `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`
- Dimensions: 256
- Embedding schema: 1
- Resolution policy: 1
- Behavior checksum: `d76062111eafdccf1e5ccbb4a79178e808ee859985dc7e2e853d6949bbb0a042`
- Catalog checksum: `7daf63059444204a60ad077a6f200964c3d39164be7218d2754614b243e9152f`
- Minimum score: 0.5812382139084729
- Minimum margin: 0.1344769661146084
- Parser baseline: `gemma3:4b-it-qat`
- Reference: Apple M1 Pro (10-core), 16 GB RAM

## Corpus counts

| Slice | Count |
| --- | ---: |
| Generated direct-label smoke | 104 |
| Generated smoke English | 52 |
| Generated smoke German | 52 |
| Authored total | 328 |
| Authored development | 228 |
| Authored held-out | 100 |
| Authored English | 163 |
| Authored German | 165 |
| Authored positives | 208 |
| Authored abstentions | 120 |
| Authored P0 | 80 |

### Authored strata

| Stratum | Count |
| --- | ---: |
| kind:direct | 0 |
| kind:paraphrase | 0 |
| kind:semantic-only | 104 |
| kind:structured | 104 |
| kind:negative | 120 |
| category-family:activities | 4 |
| category-family:aeds | 4 |
| category-family:airports | 4 |
| category-family:ambulance_stations | 4 |
| category-family:atms | 4 |
| category-family:bakeries | 4 |
| category-family:banks | 4 |
| category-family:bars | 4 |
| category-family:beaches | 4 |
| category-family:bicycle_rental | 4 |
| category-family:blood_donation | 4 |
| category-family:bookstores | 4 |
| category-family:cafes | 4 |
| category-family:camping | 4 |
| category-family:car_rental | 4 |
| category-family:car_repair | 4 |
| category-family:churches | 4 |
| category-family:cinemas | 4 |
| category-family:dentists | 4 |
| category-family:doctors | 4 |
| category-family:dog_parks | 4 |
| category-family:drinking_water | 4 |
| category-family:fire_stations | 4 |
| category-family:gyms | 4 |
| category-family:hairdressers | 4 |
| category-family:hospitals | 4 |
| category-family:hotels | 4 |
| category-family:kindergartens | 4 |
| category-family:laundromats | 4 |
| category-family:libraries | 4 |
| category-family:markets | 4 |
| category-family:mosques | 4 |
| category-family:museums | 4 |
| category-family:nightlife | 4 |
| category-family:opticians | 4 |
| category-family:parking | 4 |
| category-family:parks | 4 |
| category-family:pharmacies | 4 |
| category-family:police | 4 |
| category-family:post_offices | 4 |
| category-family:recycling | 4 |
| category-family:restaurants | 4 |
| category-family:schools | 4 |
| category-family:shopping_malls | 4 |
| category-family:supermarkets | 4 |
| category-family:swimming | 4 |
| category-family:synagogues | 4 |
| category-family:temples | 4 |
| category-family:toilets | 4 |
| category-family:transit | 4 |
| category-family:veterinarians | 4 |
| category-family:viewpoints | 4 |
| category-family:negative:proper-name | 20 |
| category-family:negative:brand | 20 |
| category-family:negative:address-code | 20 |
| category-family:negative:ambiguous | 20 |
| category-family:negative:no-place-type | 20 |
| category-family:negative:unsupported-category | 20 |

## Quality gates

| Metric | Result |
| --- | ---: |
| Direct-label top-one | 95.19% (99/104) |
| Held-out English top-one | 93.75% |
| Held-out German top-one | 96.88% |
| Macro category-family accuracy | 95.31% |
| Macro category-family accuracy, English | 93.75% |
| Macro category-family accuracy, German | 96.88% |
| Negative activation | 2.78% (1/36) |
| P0 false activations | 0 |
| Accepted English precision | 100.00% |
| Accepted German precision | 100.00% |
| Safe held-out coverage | 6.25% (4/64) |
| Keyword-miss recovery | 6.67% (4/60) |
| Gemma/default-chain plausible coverage | 81.00% (81/100) |
| Gemma-miss incremental recovery | 12.50% (2/16) |
| Gemma parse failures using production keyword fallback | 19 |
| Gemma plausible intents unchanged | 81/81 |
| Gemma plausible-intent mutations | 0 |
| Warm query-embedding p50 | 251.87 ms |
| Warm query-embedding p95 | 482.60 ms |
| Warm query-embedding p99 | 607.12 ms |
| Worst resolver bypass p95 | 12.89 ms |

Direct-label miss IDs: `direct:atms:en`, `direct:mosques:de`, `direct:parks:en`, `direct:parks:de`, `direct:veterinarians:de`

## Policy outcome and abstention-reason counts

| Outcome/reason | Count |
| --- | ---: |
| address-code | 6 |
| already-plausible | 5 |
| below-margin | 31 |
| below-score | 21 |
| brand | 4 |
| matched | 5 |
| not-eligible | 1 |
| proper-name | 27 |

## Confusion matrix

| Expected | Raw top category | Count |
| --- | --- | ---: |
| abstain:address-code | activities | 1 |
| abstain:address-code | banks | 1 |
| abstain:address-code | post_offices | 1 |
| abstain:address-code | schools | 1 |
| abstain:address-code | shopping_malls | 2 |
| abstain:ambiguous | activities | 5 |
| abstain:ambiguous | shopping_malls | 1 |
| abstain:brand | drinking_water | 1 |
| abstain:brand | shopping_malls | 5 |
| abstain:no-place-type | activities | 3 |
| abstain:no-place-type | shopping_malls | 2 |
| abstain:no-place-type | transit | 1 |
| abstain:proper-name | activities | 1 |
| abstain:proper-name | cafes | 1 |
| abstain:proper-name | hotels | 1 |
| abstain:proper-name | libraries | 1 |
| abstain:proper-name | museums | 1 |
| abstain:proper-name | nightlife | 1 |
| abstain:unsupported-category | car_rental | 4 |
| abstain:unsupported-category | drinking_water | 2 |
| atms | atms | 4 |
| bookstores | bookstores | 4 |
| car_repair | car_repair | 4 |
| hairdressers | hairdressers | 4 |
| hotels | hotels | 4 |
| laundromats | laundromats | 4 |
| libraries | libraries | 3 |
| libraries | schools | 1 |
| mosques | mosques | 4 |
| parks|activities | activities | 1 |
| parks|activities | parks | 3 |
| pharmacies | pharmacies | 4 |
| recycling | recycling | 4 |
| supermarkets | restaurants | 1 |
| supermarkets | shopping_malls | 1 |
| supermarkets | supermarkets | 2 |
| swimming | swimming | 4 |
| synagogues | synagogues | 4 |
| veterinarians | veterinarians | 4 |
| viewpoints | viewpoints | 4 |

## Resolver bypass latency

| Stratum | p95 ms |
| --- | ---: |
| already-plausible | 10.10 |
| coordinate-address | 0.00 |
| english-proper-name | 9.56 |
| exact-brand | 10.17 |
| german-proper-name | 12.89 |
| letter-free | 0.00 |
| shape-empty | 0.00 |
| shape-overlength | 0.00 |
| uppercase-code | 0.00 |
| url | 0.00 |

## Residency

- Not supplied; a quality-only verdict cannot activate the fallback.

## Failures

- negative activation exceeds 1%
- direct-label top-one accuracy is below 100%
- safe coverage is below 60%
- keyword recovery is below 25%
- worst bypass p95 is not below 1 ms

## Held-out outcomes

Only frozen query IDs are included. Query text, parser output, and embeddings are intentionally excluded.

| Query ID | Expected | Raw top category | Applied category | Policy-correct |
| --- | --- | --- | --- | --- |
| positive:atms:en:semantic | category | atms | — | no |
| positive:atms:en:structured | category | atms | — | no |
| positive:atms:de:semantic | category | atms | — | no |
| positive:atms:de:structured | category | atms | — | no |
| positive:bookstores:en:semantic | category | bookstores | — | no |
| positive:bookstores:en:structured | category | bookstores | — | no |
| positive:bookstores:de:semantic | category | bookstores | — | no |
| positive:bookstores:de:structured | category | bookstores | — | no |
| positive:car_repair:en:semantic | category | car_repair | — | no |
| positive:car_repair:en:structured | category | car_repair | — | no |
| positive:car_repair:de:semantic | category | car_repair | — | no |
| positive:car_repair:de:structured | category | car_repair | — | no |
| positive:hairdressers:en:semantic | category | hairdressers | — | no |
| positive:hairdressers:en:structured | category | hairdressers | — | no |
| positive:hairdressers:de:semantic | category | hairdressers | — | no |
| positive:hairdressers:de:structured | category | hairdressers | — | no |
| positive:hotels:en:semantic | category | hotels | hotels | yes |
| positive:hotels:en:structured | category | hotels | — | no |
| positive:hotels:de:semantic | category | hotels | — | no |
| positive:hotels:de:structured | category | hotels | — | no |
| positive:laundromats:en:semantic | category | laundromats | — | no |
| positive:laundromats:en:structured | category | laundromats | — | no |
| positive:laundromats:de:semantic | category | laundromats | — | no |
| positive:laundromats:de:structured | category | laundromats | — | no |
| positive:libraries:en:semantic | category | libraries | — | no |
| positive:libraries:en:structured | category | libraries | — | no |
| positive:libraries:de:semantic | category | schools | — | no |
| positive:libraries:de:structured | category | libraries | libraries | yes |
| positive:mosques:en:semantic | category | mosques | — | no |
| positive:mosques:en:structured | category | mosques | — | no |
| positive:mosques:de:semantic | category | mosques | — | no |
| positive:mosques:de:structured | category | mosques | — | no |
| positive:parks:en:semantic | category | parks | — | no |
| positive:parks:en:structured | category | parks | — | no |
| positive:parks:de:semantic | category | activities | — | no |
| positive:parks:de:structured | category | parks | — | no |
| positive:pharmacies:en:semantic | category | pharmacies | — | no |
| positive:pharmacies:en:structured | category | pharmacies | — | no |
| positive:pharmacies:de:semantic | category | pharmacies | pharmacies | yes |
| positive:pharmacies:de:structured | category | pharmacies | — | no |
| positive:recycling:en:semantic | category | recycling | — | no |
| positive:recycling:en:structured | category | recycling | recycling | yes |
| positive:recycling:de:semantic | category | recycling | — | no |
| positive:recycling:de:structured | category | recycling | — | no |
| positive:supermarkets:en:semantic | category | restaurants | — | no |
| positive:supermarkets:en:structured | category | shopping_malls | — | no |
| positive:supermarkets:de:semantic | category | supermarkets | — | no |
| positive:supermarkets:de:structured | category | supermarkets | — | no |
| positive:swimming:en:semantic | category | swimming | — | no |
| positive:swimming:en:structured | category | swimming | — | no |
| positive:swimming:de:semantic | category | swimming | — | no |
| positive:swimming:de:structured | category | swimming | — | no |
| positive:synagogues:en:semantic | category | synagogues | — | no |
| positive:synagogues:en:structured | category | synagogues | — | no |
| positive:synagogues:de:semantic | category | synagogues | — | no |
| positive:synagogues:de:structured | category | synagogues | — | no |
| positive:veterinarians:en:semantic | category | veterinarians | — | no |
| positive:veterinarians:en:structured | category | veterinarians | — | no |
| positive:veterinarians:de:semantic | category | veterinarians | — | no |
| positive:veterinarians:de:structured | category | veterinarians | — | no |
| positive:viewpoints:en:semantic | category | viewpoints | — | no |
| positive:viewpoints:en:structured | category | viewpoints | — | no |
| positive:viewpoints:de:semantic | category | viewpoints | — | no |
| positive:viewpoints:de:structured | category | viewpoints | — | no |
| negative:proper-name:01 | abstain | cafes | — | yes |
| negative:proper-name:02 | abstain | hotels | — | yes |
| negative:proper-name:03 | abstain | activities | — | yes |
| negative:proper-name:04 | abstain | museums | — | yes |
| negative:proper-name:05 | abstain | libraries | — | yes |
| negative:proper-name:06 | abstain | nightlife | — | yes |
| negative:brand:01 | abstain | shopping_malls | — | yes |
| negative:brand:02 | abstain | shopping_malls | — | yes |
| negative:brand:03 | abstain | shopping_malls | — | yes |
| negative:brand:04 | abstain | drinking_water | — | yes |
| negative:brand:05 | abstain | shopping_malls | — | yes |
| negative:brand:06 | abstain | shopping_malls | — | yes |
| negative:address-code:01 | abstain | post_offices | — | yes |
| negative:address-code:02 | abstain | shopping_malls | — | yes |
| negative:address-code:03 | abstain | schools | — | yes |
| negative:address-code:04 | abstain | shopping_malls | — | yes |
| negative:address-code:05 | abstain | activities | — | yes |
| negative:address-code:06 | abstain | banks | — | yes |
| negative:ambiguous:01 | abstain | activities | — | yes |
| negative:ambiguous:02 | abstain | activities | — | yes |
| negative:ambiguous:03 | abstain | shopping_malls | — | yes |
| negative:ambiguous:04 | abstain | activities | — | yes |
| negative:ambiguous:05 | abstain | activities | activities | no |
| negative:ambiguous:06 | abstain | activities | — | yes |
| negative:no-place-type:01 | abstain | activities | — | yes |
| negative:no-place-type:02 | abstain | activities | — | yes |
| negative:no-place-type:03 | abstain | shopping_malls | — | yes |
| negative:no-place-type:04 | abstain | shopping_malls | — | yes |
| negative:no-place-type:05 | abstain | transit | — | yes |
| negative:no-place-type:06 | abstain | activities | — | yes |
| negative:unsupported-category:01 | abstain | car_rental | — | yes |
| negative:unsupported-category:02 | abstain | car_rental | — | yes |
| negative:unsupported-category:03 | abstain | drinking_water | — | yes |
| negative:unsupported-category:04 | abstain | drinking_water | — | yes |
| negative:unsupported-category:05 | abstain | car_rental | — | yes |
| negative:unsupported-category:06 | abstain | car_rental | — | yes |

Verdict: FAIL
