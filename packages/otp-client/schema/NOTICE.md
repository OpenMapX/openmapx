# OpenTripPlanner schema provenance

`gtfs-2.10.graphql` is the unmodified GTFS API SDL from OpenTripPlanner v2.10.0:
https://github.com/opentripplanner/OpenTripPlanner/blob/v2.10.0/application/src/main/resources/org/opentripplanner/apis/gtfs/schema.graphqls

SHA256: `ee5c42d5fd6346b6062d057030f8cb2062517b31e93add66ca5a92cae247aac4`.
The upstream LICENSE is retained beside the schema (LGPL-3.0-or-later and incorporated notices). This is software/schema provenance, not a licence for configured transit feed data.

SDKs contain prebuilt document ASTs; generated bindings retain their wire strings and result validators. Runtime needs no GraphQL parser. The validator plugin output is projected to complete selected operation declarations and their generated enum dependencies using the TypeScript AST; expressions are retained unchanged, and missing dependencies fail generation. Unused input validators are omitted because the published plugin emits Zod 4 input annotations that fail strict TypeScript checking.

Generate offline using `pnpm otp:generate`; verify using `pnpm check-otp`. GraphQL 16 is build-only in `@openmapx/otp-codegen`. Generated runtime code depends on Zod, not GraphQL. Original schema bytes are not patched.
