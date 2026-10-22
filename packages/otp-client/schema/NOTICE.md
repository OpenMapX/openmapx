# OpenTripPlanner schema provenance

`gtfs-2.10.graphql` is the unmodified GTFS API SDL from OpenTripPlanner v2.10.0:
https://github.com/opentripplanner/OpenTripPlanner/blob/v2.10.0/application/src/main/resources/org/opentripplanner/apis/gtfs/schema.graphqls

SHA256: `ee5c42d5fd6346b6062d057030f8cb2062517b31e93add66ca5a92cae247aac4`.
The upstream LICENSE is retained beside the schema (LGPL-3.0-or-later and incorporated notices). This is software/schema provenance, not a licence for configured transit feed data.

SDKs contain prebuilt document ASTs; generated bindings retain their wire strings and result validators. Runtime needs no GraphQL parser. The validator plugin output is projected to complete selected operation declarations and their generated enum dependencies using the TypeScript AST; expressions are retained unchanged, and missing dependencies fail generation. Unused input validators are omitted because the published plugin emits Zod 4 input annotations that fail strict TypeScript checking.

Generate offline using `pnpm otp:generate`; verify using `pnpm check-otp`. GraphQL 16 is build-only in `@openmapx/otp-codegen`. Generated runtime code depends on Zod, not GraphQL. Original schema bytes are not patched.

## Dynamic public provider profiles

The following readable SDL snapshots were derived on 2026-10-22 from the public deployed GraphQL introspection response using GraphQL 16.14.2 `buildClientSchema` and `printSchema` (no schema-field patching). Provider names identify the deployed contract, not a promise about its OTP version.

- `stadtnavi.graphql`: https://api.stadtnavi.de/otp/gtfs/v1; SDL SHA256 `bc167110515cf18fb07a478d815c7be85b1fe649f79430eb6bc16907c5b9cf46`.
- `peatus.graphql`: https://api.peatus.ee/routing/v1/routers/estonia/index/graphql; SDL SHA256 `1d57c9c9699634f4b5529efcd79124812c6cfa3de253543a6708d0a2d3533480`.
- `torino.graphql`: https://mapi.5t.torino.it/routing/v1/routers/mat/index/graphql; SDL SHA256 `7c2f4f35d132b32ba12618c4ce22693ef7a71ddba58ddd4b9a6ae734ac363bd7`.
- `trufi.graphql`: https://otp281.trufi.app/otp/transmodel/v3; SDL SHA256 `68e1f73f450127db1c0d82f27e5b73271087d30e01030d49f058d1975718a9fe`.

Digitransit generation uses the official upstream `gtfs-2.10.graphql` contract for the documented GTFS API. Its authenticated deployed schema and responses have not been qualified without an operator credential; no compatibility guarantee is inferred from anonymous 401s. See https://digitransit.fi/en/developers/apis/1-routing-api/ and https://digitransit.fi/en/developers/api-registration/.

Four GTFS profiles share one owned operation document, generated independently to preserve their actual enums and nullability. Trufi uses separate Transmodel operations and generated types. Upstream OTP's retained software licence covers schema provenance; provider feed/service permissions remain separate and unknown unless declared by the contributing catalog entry. Public profiles have bounded host HTTP and shared cooldown hooks. Their text response path discards unsuccessful bodies before decoding so status/Retry-After remains available even for non-JSON, oversized or stalled errors; successful GraphQL JSON is decoded and validated strictly. Self-hosted OTP retains its original JSON response path and does not require shared admission.
