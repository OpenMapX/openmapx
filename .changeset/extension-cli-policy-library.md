---
"@openmapx/extension-cli": minor
---

The CLI package now holds the source-level policy analysis that the OpenMapX
repository runs on its integrations: the provider HTTP rules (raw `fetch`,
`fetchJson` in a module that reads a credential, a coordinate that defaults to
zero), the direct integration cache write rule, and the relative-import graph
from a backend entry. The repository's gates call this library, so a later
`openmapx-ext lint` applies the same rules to an extension's code. `fetchJson`
imported from `@openmapx/integration-sdk/http` and `fetchJsonWithTimeout` from
`@openmapx/integration-sdk/weather` count as the same helpers as the
repository's own.

`typescript` becomes a runtime dependency of the CLI, about 23 MB installed,
because the analysis parses source with the TypeScript compiler API. The
existing commands are unchanged.
