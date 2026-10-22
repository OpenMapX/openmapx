# MBTA wire contract provenance

`swagger.json` is the original official https://api-v3.mbta.com/docs/swagger/swagger.json snapshot retrieved 22 October 2026. SHA-256: `16fd4783e1862ac5f1433b8d98b8d06a6599d0c9a3962f0aa5941538bca33906`.

The official https://github.com/mbta/api repository is MIT licensed, copyright 2018 Massachusetts Bay Transportation Authority; its licence is reproduced in LICENSE. Research source reference: d71592b576dda5d37abddfc2ef0cd24a37551af2. This notice covers specification/software provenance, not the separate terms applying to supplied transit data.

`scripts/mbta/contract.mjs` selects the six used operations and consumed fields from the upstream definitions. Corrections: JSON:API nullable to-one linkage and pagination links; typed prediction includes; resource-kind and ID requirements; nullable optional GTFS fields emitted by the views; ISO timestamps for prediction/schedule times. The unused prediction status attribute is excluded, avoiding its undocumented nullable spelling. No returned data is normalized by deleting nulls. Documentation-only schema descriptions are omitted from executable validators; they remain intact in the original snapshot.

Sources: official `apps/api_web/lib/api_web/views/{prediction,schedule,vehicle,trip,facility}_view.ex`, `apps/api_web/lib/api_web/plugs/version.ex`, production rate config, and https://jsonapi.org/format/#document-resource-object-linkage. Review the original snapshot, projection and regeneration together. The API date header is deliberately 2021-01-09, the current established default; the specification info version is not an API date.
