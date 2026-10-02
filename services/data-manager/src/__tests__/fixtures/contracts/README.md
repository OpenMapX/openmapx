# OpenConditions → OpenMapX contract fixtures

These are pinned, byte-identical copies of OpenConditions' publisher golden
fixtures for the routing wire contract, schema version 2:
`packages/publishers/src/__tests__/fixtures/contracts/` in OpenConditions. Each
file is the actual output of OpenConditions' `segmentConditionsToJson` at the
frozen instant `2026-09-11T12:00:00.000Z`: `/segments/conditions.json` lists
one condition per bound effect of a road situation (`<situationId>#<effectId>`),
with the model effect itself and its routing evidence.

- `road-conditions-v2.json`: a full road closure.
- `road-speed-cap-v2.json`: a mandatory temporary speed limit.
- `road-restrictions-v2.json`: the closure as an unconditional control, plus
  the vehicle-specific effects the real parsers produce: four NDW records (a
  height condition, an emergency-service usage and two lorry closures) and a
  Fintraffic weight limit.

`road-conditions-contract.test.ts` consumes them in OpenMapX's normal test
suite with the real conditions parser, edge converter and receipt builder. It
checks preservation of the parent/child source and licence evidence,
forward-only closure mapping, the speed cap, receipts keyed by effect and record
revision, source exclusions, expiry, ambiguous bindings, and that no
vehicle-specific effect closes or caps an edge while the control still does. No
live feed or cross-repository source import is required.

Do not edit these files by hand. For an intentional contract change, regenerate
the goldens in OpenConditions, review the diff, copy the three files here
unchanged and run both repositories' suites. Do not refresh timestamps: the
fixed clock and the golden output detect drift.

The closure, the speed limit and the road identities are authored test data;
their licence fields only exercise provenance handling. The Fintraffic record is
real reviewed source data under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/) and the NDW records are real
reviewed source data under CC0 1.0
(https://creativecommons.org/publicdomain/zero/1.0/).
