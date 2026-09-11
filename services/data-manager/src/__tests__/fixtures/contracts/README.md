# OpenConditions → OpenMapX contract fixture

`road-conditions-v1.json` is the golden output of OpenConditions' actual
`segmentConditionsToJson` publisher. Its producer test and synthetic input live
under `packages/publishers/src/__tests__/` in OpenConditions. This copy is consumed
by `road-conditions-contract.test.ts` in OpenMapX's normal test suite.

Tests use the fixed instant `2026-09-11T12:00:00.000Z`. They check preservation of
the original parent/child source and licence evidence, forward-only closure
mapping, source exclusions, expiry and ambiguous bindings. No live feed or
cross-repository source import is required.

For an intentional contract change, update both repositories' fixture copies and
run both tests. Compare parsed JSON, since their formatters differ. Keep the
expected fixture independent of the producer during tests so output drift fails.

The fixture is authored synthetic test data. Licence metadata is illustrative
and does not grant rights for any real upstream source.
