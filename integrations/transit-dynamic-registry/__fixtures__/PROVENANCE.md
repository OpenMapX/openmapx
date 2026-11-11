# HAFAS fixtures

The HAFAS adapter consumes the parsed objects that `hafas-client` returns, not
the raw mgate payload. These fixtures are the example results printed in
`hafas-client` 6.3.6's documentation (ISC licence), for its VBB profile:

- `hafas-nearby.json`: `docs/nearby.md`, the first two stops. The second stop's
  elided `products` was dropped.
- `hafas-departures.json`: `docs/departures.md`, the first two departures. The
  second departure's elided `operator` and `stop` were dropped, and the
  `realtimeDataUpdatedAt` field described in the same document was given a value.

They contain no credentials and no personal data.
