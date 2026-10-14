# **ID** companion response contract

This integration artifact is declarative. Keep executable behavior in a
companion service and connect it through an existing versioned host protocol or
a reviewed built-in adapter. The host does not automatically consume
`companion-response.example.json`; it is a service-response example excluded
from the packaged artifact. No remote scripts, callbacks or host imports belong
in this artifact.

Replace the example publisher and notices with real metadata. Declare the
actual upstreams in `manifest.json` and source-ID-keyed localized privacy
strings. The scaffold's empty `dataSources` list is not a declaration that all
external inputs are credit-free.

Capture canonical `contributors` before upstream acquisition and keep them with
the cached record. `sourceId` and `name` are required; `url`, `attributionText`, `retrievedAt`, `notes`, and
`publisher: { name, url? }` are optional. Preserve all mandatory wording: two
notices from the same source remain distinct. Parent credit identity needs an
explicit producer relationship, not an ID-prefix guess.

A supplied `contributors: []` is authoritative and stops fallback. Omitted
contributors mean unavailable captured provenance; never turn an unknown mixed
row into credits for the whole catalogue. Derive envelope credits from retained
rows and fields after filtering and merging, and preserve old receipts during
refresh/outage. Selected display lineage does not replace a broader rights/audit
dependency list.

`fieldContributors` records actual field ownership. A container entry applies to
its child tree; the nearest child entry overrides it, including `[]`. The
example deliberately leaves `details.website` empty despite its parent's
receipt. A replacement/renamed container must retain its entire child tree. A
view credits only displayed fields and represented facts/photos. Commons photos
also need exact per-file author, license and file-page metadata.

GeoJSON/MVT can carry canonical credits as JSON text in
`properties._mapAttributions`. The trusted host validates copied receipts,
sanitizes attribution HTML and links, and selects actual rendered geometry or
successful retained raster content. A toggle, service health or registered
provider is not contribution proof. Malformed metadata cannot authorize code or
whole-domain fallback.

Use the portable helpers from `@openmapx/mobility-core/contributors` if useful;
they are not a same-origin presentation SDK. Built-in authors use the focused
host integration API. Installed community artifacts cannot execute its hooks.

See the OpenMapX developer guides: Integration system, Writing an integration,
and Building an external extension. Test malformed and explicit empty payloads,
field/container child ownership, retained caches, exact row pruning and safe
rendering through your reviewed adapter before publishing.

Licence metadata uses `licensing: { version: 1, bindings: [...] }`. Each binding
has a scope and subject, with a registered SPDX expression or a self-contained
custom definition (`LicenseRef-...`, namespace, name and URL). Use your extension
namespace; preserve conditions and notices. Engine/software, data/imagery/style
and API/service terms are separate subjects. Unknown and per-item licences stay
explicit. See docs/docs/developer/licensing.md. Never send flat `spdxLicense`,
`license` or `licenseUrl` display fields or guess a grant from a composite label.

Capture optional reviewed `licensing.bindings[].attribution` policies with each receipt. Required fields are placement (`visible` or `details`), exact surfaces (`map`, `content`, `image`), basis, reviewedAt, evidenceUrls and reason. Only certify compactText when exact terms allow abbreviation; unresolved terms stay fully visible. `includePublisher: true` preserves the actual issuing publisher. Approved logo identifiers select local host assets; no remote asset URLs or executable callbacks. The host uses reviewed SPDX defaults plus these source/product overrides, not a mutable source catalogue. Every mandatory notice remains adjacent, and complete current notices are directly accessible by keyboard/touch. Installed artifacts cannot grant themselves execution or data permissions through placement metadata.
