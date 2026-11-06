# Shared travel plans: revised implementation plan

> Use superpowers:executing-plans. Root agent implements; Claude Opus reviews.
> The user clarified normal provider-trip selection with essentially no new UI.
> This replaces the previous fixed-import plan.

**Spec:** `docs/superpowers/specs/2026-11-06-shared-travel-plans-design.md`

## 1. Review the revised design

- [x] Reassess the user's clarification against the existing implementation.
- [x] Inspect pinned MOTIS structured reconstruction and ordinary query/selection paths.
- [x] Self-review this spec/plan and obtain Claude Opus design review.
- [x] Resolve review findings before implementation; use distinct reference queries for reconstruction (B1).

## 2. Return normal provider itineraries

Keep parsing/native preservation and identity matching. Replace composition in
`packages/core/src/travel-plans/{resolve,apiPort}.ts` with normal-plan exact matching
and a source-neutral provider reconstruction fallback.

- [ ] Add failing tests that require untouched complete provider plans and exact selected identity.
- [ ] Add normal planning, one discovery page/re-anchor, optional service-mode retry and whole-sequence exact matching. Seed only unpaged results.
- [ ] Define bounded typed provider trip references and optional `resolveTrip` capability.
- [ ] Add validated `POST /plan/resolve`, orchestration and MOTIS local/hosted adapters.
- [ ] Use native structured refresh, raw response validation, honest hosted feature detection and source policy. Reference refresh may never replan to another trip.
- [ ] Add negative tests for substitutions, merged/dummy legs, invalid transfers and unsupported sources.
- [ ] Regenerate OpenAPI, inspect diff and update developer documentation.

## 3. Reuse normal directions state and UI

- [ ] Remove import summary/banner/alternatives strings and components, composed geometry and permanent imported mode.
- [ ] Share canonical normal request/key construction and capabilities options. Add a distinct provider-reference query variant, not a fake search cache entry.
- [ ] Lift transit time mode into the store, move stable itinerary identity to core and add the one-shot raw/debounced-key selection handoff.
- [ ] Seed the complete provider envelope under its truthful query key and atomically publish matching route inputs/selection. Preserve wheelchair/mandatory requirements and persisted hill preference.
- [ ] Open ordinary details after matching-key publication and ranking. Keep existing normal refetch behavior; reference refetch re-resolves the same trip, without paging.
- [ ] Test mounted-panel/debounce/stale-query/capability and geolocation races.
- [ ] Keep the existing confirmation/authority/acknowledgement contract and generic errors.

## 4. Verify and review

- [ ] Run focused parser/provider/store/hook/intake tests and affected types.
- [ ] Inspect ordinary details with intentionally different provider data and production theme.
- [ ] Exercise native MOTIS2.11.4 reconstruction/POST options with an isolated synthetic timetable if available; distinguish this from real provider coverage.
- [ ] Obtain Claude Opus revised implementation review; fix supported findings and verify.
- [ ] Run full local gates and relevant mobile/Swift/bundle/docs checks. Report any unrelated failures accurately.

## 5. Deliver

- [ ] Replace obsolete visual evidence with actual normal directions behavior and inspect it.
- [ ] Commit, push, open PR with Medformatik assignment and existing appropriate label.
- [ ] Immediately link the PR, inspect uploaded hosted images/body and verify metadata.

The old portable run was stopped after the user's clarification; it is not final
verification of this design. Existing build-artifact timeout failures are tracked
in the local ledger; do not weaken those tests or silently call the old run green.
