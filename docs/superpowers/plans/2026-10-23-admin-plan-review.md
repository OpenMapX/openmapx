# Controller plan self-review

Reviewed the specification, all nine subsystem plans and actual producer/consumer
boundaries before product implementation. Baseline remains
`ef896ceae876959180116cf61ffcf643b88ebffe`; no product edits have occurred.

## Scope coverage

| Scope   | Owning tasks                                         |
| ------- | ---------------------------------------------------- |
| S01,S02 | 01.2,01.6                                            |
| S03     | 01.3,01.6                                            |
| S04,S05 | 01.1,01.6                                            |
| S06     | 01.4,01.6                                            |
| S07,S08 | 01.5,01.6                                            |
| J01,J02 | 02.1,02.2                                            |
| J03     | 02.2–02.4                                            |
| J04     | 02.4                                                 |
| A01–A04 | 03.1,03.6                                            |
| A05     | 03.5                                                 |
| A06–A08 | 03.3,03.4,03.6                                       |
| A09,A10 | 03.2,03.5                                            |
| I01,I02 | 04.1,04.2                                            |
| I03,I04 | 04.3,04.4 with06.2 transport                         |
| I05,I06 | 04.5,04.6 with03.3 assurance                         |
| D01     | 05.1                                                 |
| D02–D04 | 05.2                                                 |
| D05     | 05.7 foundation,05.3 with06.1 lease                  |
| D06,D07 | 05.4,05.5                                            |
| D08,D09 | 05.7/05.6 with03.3/04.2                              |
| T01–T04 | 06.1–06.5                                            |
| P01–P06 | 07.1–07.6                                            |
| C01–C07 | 08.1–08.4                                            |
| M01–M03 | 09.1,09.2 including catalogue filters/root controls  |
| M04–M06 | 09.3–09.5                                            |
| M07,C04 | 09.6 host guidance and actual render-only generation |
| Q01–Q05 | masterQ1–Q3 integrated qualification/one green PR    |

## Rulings from self-review

The master records binding exact interfaces, exclusive implementation windows,
execution order and append-only migration allocation. Specific corrections:

- Preserve secure auth upgrade defaults; require explicit version1 activation
  instead of turning formerly inert false database values into live policy.
- Protect the last full administrator before destructive erasure hooks and at
  the database boundary. Normalize historical recognized role combinations
  without accidentally removing effective administrator authority.
- Separate observer loss, cancellation intent, proven containment, failed work
  and unknown effects. Bounded retained output never kills a useful build.
- Share one cross-process target lease and lock order across CLI/agent/data
  manager; do not hold a parent lease while awaiting a child that needs it.
- Create shared portable result types before their consumers; require exact
  generation conditions on API-role lifecycle requests. Keep canonical schemas,
  actual serializers, SDKs and production assembly in the same task window.
- Reserve disk by actual admitted/manifest sizes and separately bound metadata;
  verify the agent's supported memory budget with measured archive tests.
- Cover all30 built-ins, resource placement and boolean adapters. Known platform
  adoption is explicit; service/integration host-owned values stay locked.
- Domain change previews include DNS/TLS/OAuth/passkey prerequisites, alternate
  admin recovery, and retained reconnect evidence. Agent resource application
  uses its external helper, never generic self-recreation.
- Add missing routine catalogue/root controls and render-only generation rather
  than equating preview or queued admission with application.

## Conflict and test scan

The durable SDD ledger contains a row for each of50 tasks and774 shared
file/interface pairs in `preflight-scan.md`. Shared files receive one exclusive
task window; producer signatures and the master's binding rulings govern the
consumer. Controller-only generation/full qualification remains separate from
worker checks. No concurrent product edits or migrations are permitted.

All tasks specify causal RED/GREEN checks, authorization/refusal cases and their
own Review Focus assertions. Full qualification includes real assembled runtime
dispatch, migrated synthetic PostGIS, actual byte streams, interrupted work,
rendered desktop/mobile admin states and latest-head CI. Mocked/source checks
are not represented as runtime acceptance.

Fresh worktree baseline:510 passed,5 skipped across17 focused files. Both frozen
installs completed. Docker and GitHub access verified; an owned synthetic
PostGIS18/PostGIS3.6 container has successfully applied baseline migrations.
These are baseline receipts, not evidence that future changes pass.

## Independent review

Round1 fresh Codex review found0Critical/13Important. All13 were source-verified and accepted, with a source-grounded correction to the raster traffic consumer forR1-13. Corrected contracts live in the binding control-protocol supplement and plans01–09; responses are retained in the SDD workspace. No finding is silently deferred.

A new independent round2 verifies the original findings and new breakage in their corrections before product edits. No user questions or approval pause is needed or requested.

## Round1 correction self-review

- R1-05: original admission clamp, body/execution fingerprints, authenticated parent deadline, no renewal; four separate clocks.
- R1-01: role keys/private mounts, anchored finite grants, both-direction adoption, durable attempts and settlement-before-release.
- R1-02: retained key per child phase; POST loss lookup; cancel intent/containment before rollback/release.
- R1-03/10: global API→integration→host; strict complete source reads, exact sealed512KiB budget before persistence; same transaction participant and durable unknown fence.
- R1-06: void runner reads exact private signed seed/final receipt, never stdout or competing current generation.
- R1-07: require-running binds preflight/identity/checkpoint, empty plan needs none; no Start fallback.
- R1-08: foundation precedes paired-pin consumers; credential invalidation precedes activation.
- R1-09: check/checkMany before prepare; consume/consumeMany atomically with ordinary+managed writes; sole overlayChange seam.
- R1-03/09: final64KiB UTF8,1000keys,512codepoints/key,8192bytes/value; duplicate/invalid Unicode rejected; generic PUT/DELETE blocked.
- R1-11/12: callback owns byte lifetime/auth; limited native target; uploaded-artifact immutable claim through install/settle; no detached Response/finally-release.
- R1-04: fresh supported password+effectiveMFA bound to actor/preview/policy; unknown password/OTP/federated/passkey alone denied.
- R1-04: API parent, terminal helper prepare before drain, actual same-image runtime proof; no live agent ancestor or blind relaunch/rollback.
- R1-13: raster traffic shared layer/selector zoom, dynamic server projection, supported relative URL grammar.

Baseline migrated suites completed:api-privacy23files/129tests; ingestion13files/65tests; export-restore2files/7tests with synthetic retained backup. These remain baseline receipts only.

## Round2 correction review and recovery

Round2 cleared11/13 original findings and identified two unique Important seams: the delegated agent-owned paired-pin CAS and remote pre-save feed/configuration ownership. Corrected control-protocol§4.1/§5.4 and plans01/02/04/05/06/08 now define the finite publication leaf, exact attempt receipt, agent-owned terminal prepared maintenance root, durable DM admission guard, atomic DB continue decision and borrowed apply/recreation/settlement. No generic lock endpoint or new API mount is introduced. The existing50-task order and0042–0050 forward migrations remain.

The correction worker hit a provider usage limit after writing the substantive protocol/report. Its files were recovered from exact historical document-write inputs after ignored files disappeared. The controller checked those recovery errors against the original tool receipts, regenerated50 tasks/774 pair rows, completed the explicit hardlinkPlanDigest fields and reformatted the documents. Prior product/database checks remain historical; no product change or runtime acceptance is claimed. A NEW independent round3 must verify both open findings and correction-caused material breakage before implementation.
