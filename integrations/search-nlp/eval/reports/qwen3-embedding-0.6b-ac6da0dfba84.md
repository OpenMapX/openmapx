# Semantic Taxonomy Evaluation

- Model: `qwen3-embedding:0.6b`
- Model digest: `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`
- Dimensions: 256
- Embedding schema: 1
- Resolution policy: 1
- Behavior checksum: `d76062111eafdccf1e5ccbb4a79178e808ee859985dc7e2e853d6949bbb0a042`
- Catalog checksum: `7daf63059444204a60ad077a6f200964c3d39164be7218d2754614b243e9152f`
- Minimum score: 0.5791104718902661
- Minimum margin: 0.13513005083795082
- Parser baseline: `gemma3:4b-it-qat`
- Reference: Apple M1 Pro (10-core), 16 GB RAM

## Quality gates

| Metric | Result |
| --- | ---: |
| Direct-label top-one | 95.19% (99/104) |
| Held-out English top-one | 93.75% |
| Held-out German top-one | 96.88% |
| Macro category-family accuracy | 95.31% |
| Negative activation | 2.78% (1/36) |
| P0 false activations | 0 |
| Accepted English precision | 100.00% |
| Accepted German precision | 100.00% |
| Safe held-out coverage | 4.69% (3/64) |
| Keyword-miss recovery | 5.00% (3/60) |
| Gemma-miss incremental recovery | 9.09% (2/22) |
| Gemma parse failures using production keyword fallback | 25 |
| Gemma plausible-intent mutations | 0 |
| Warm query-embedding p95 | 634.63 ms |
| Worst resolver bypass p95 | 12.49 ms |

## Resolver bypass latency

| Stratum | p95 ms |
| --- | ---: |
| already-plausible | 10.00 |
| coordinate-address | 0.00 |
| english-proper-name | 10.07 |
| exact-brand | 11.08 |
| german-proper-name | 12.49 |
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
- warm embedding p95 exceeds 500 ms
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
| positive:libraries:de:structured | category | libraries | — | no |
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
| negative:brand:02 | abstain | restaurants | — | yes |
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
| negative:no-place-type:01 | abstain | restaurants | — | yes |
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
