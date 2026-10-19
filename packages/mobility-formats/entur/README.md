# Entur GraphQL contracts

This directory owns the GraphQL operation contracts used by `transit-entur` and
`live-transit-entur`: 15 unique operations replace the 17 previous operation
documents across both integrations. The two schema families are separate
generation targets:

| Family                       | Source endpoint                                     | Local inputs                                                           | Generated output               |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| Journey planner (Transmodel) | `https://api.entur.io/journey-planner/v3/graphql`   | `schema/journey-planner.graphql`, `operations/journey-planner.graphql` | `journey-planner.generated.ts` |
| Realtime vehicles            | `https://api.entur.io/realtime/v2/vehicles/graphql` | `schema/vehicles.graphql`, `operations/vehicles.graphql`               | `vehicles.generated.ts`        |

Edit the operation documents when changing a selection or its variables. Do not
hand-edit generated TypeScript or the schema snapshots. From the repository root:

```sh
pnpm entur:generate
pnpm check-entur-graphql
pnpm exec vitest run scripts/entur/codegen.test.ts --project node
```

`entur:generate` validates operations against the committed SDL and writes the
generated files. `check-entur-graphql` runs the same generation and Biome formatting
in memory, compares the complete output, and fails on missing or stale files
without rewriting them. Both commands work offline after the frozen-lockfile
install. CI uses the check command; it never introspects a live provider.

The exact-pinned GraphQL Code Generator packages at the root produce operation
result/variable types and typed string documents using the `typescript-operations`
and `typed-document-node` plugins. Operations v6 also generates its referenced
input, enum and utility types; adding the older companion `typescript` plugin to
the same output duplicates declarations. See the official
[v6 migration guide](https://the-guild.dev/graphql/codegen/docs/migration/operations-and-client-preset-from-5-0)
and the installed `typescript-operations` implementation. Generation follows the
official [programmatic API](https://the-guild.dev/graphql/codegen/docs/advanced/programmatic-usage)
and [string document mode](https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#documentmode).
String documents retain the existing HTTP transport and its JSON request bodies;
no GraphQL runtime client is required. Generated types are compile-time contracts,
not runtime validators for arbitrary provider JSON. The private
[`@openmapx/entur-client`](../../entur-client/README.md) owns host HTTP transport,
immutable configuration/receipts, shared admission, observed provider cooldowns
and bounded errors. It validates the GraphQL envelope, including rejecting
partial/error responses, rather than every selected runtime field. Integration
setups own client/provider lifetimes, source-policy callbacks, domain mapping and
result publication. Each Entur integration remains independently configurable;
there is no shared mutable runtime facade. No additional GraphQL runtime library
is required.
Native Geocoder v3 operations and runtime validators live in the private Entur
client, separately from these GraphQL contracts; see the
[Geocoder developer guide](../../../docs/docs/developer/entur-geocoder.md) and
`pnpm check-entur-geocoder`.
The operation selections use the current situation `affects` and
`validityPeriods` fields from the pinned journey-planner schema.

The generated string-document class includes the upstream template's generic
metadata dictionary. This does not relax operation result/variable or scalar
types. Generated files carry a scoped lint suppression so fixes belong to the
generator configuration or upstream template rather than handwritten output.

## Reviewed scalar mapping

The mapping in `scripts/entur/codegen.config.mjs` follows the pinned schema descriptions:

| Scalar                                              | TypeScript wire representation                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `Date`, `DateTime`, `Duration`, `LocalTime`, `Time` | `string`                                                                  |
| `DoubleFunction`                                    | `string` (for example `30m + 2.0 t`)                                      |
| `Cost`                                              | `string` (the schema's cost input uses duration expressions such as `0s`) |
| `Coordinates`                                       | `number[][]` (coordinate pairs)                                           |
| `Long`                                              | `number` (JSON numeric representation)                                    |

Java's signed 64-bit `Long` range exceeds JavaScript's safe integer range. The
mapping does not add precision guarantees; consumers must keep values within the
range appropriate to their operation. New unmapped custom scalars fail generation
under `strictScalars`, requiring a deliberate representation review.

## Schema provenance and refresh

`schema/provenance.json` records the introspection endpoints, retrieval timestamp,
SHA-256 of each exact SDL file, and the `NLOD-2.0` license recorded for the Entur
snapshots. Entur AS supplies these API responses under its
[open-data terms](https://developer.entur.no/terms-of-service) and
[NLOD-2.0](https://data.norge.no/nlod/en/2.0). The snapshots are converted from
introspection JSON to sorted, formatted SDL; the schema semantics are unchanged.
Preserve the schema headers and existing Entur source attribution.
These snapshots describe the retrieved deployment; they do not establish that
every configurable OTP endpoint implements the same schema.

Refresh is an explicit network operation for a maintainer:

```sh
pnpm entur:refresh-schemas
pnpm entur:generate
pnpm check-entur-graphql
pnpm exec vitest run scripts/entur/codegen.test.ts --project node
```

Review the SDL and provenance diff together, including endpoints, hashes,
nullability, input types, enum additions/removals and scalar changes. Then review
the generated diff and run the affected integration tests and typechecks. Resolve
any invalid operation against the provider contract rather than weakening
validation or adding parallel handwritten wire models. Commit the reviewed schema,
provenance, operation and generated changes together. Schema refresh remains
separate from ordinary generation and CI so provider outages cannot silently
change committed contracts.
