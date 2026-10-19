# Entur Geocoder contract snapshot

`geocoder.openapi.json` is an unmodified snapshot of the official Entur Geocoder
OpenAPI document, retrieved on 2026-10-19:

- Source: <https://developer.entur.no/apis/geocoder/latest/openapi.json>
- OpenAPI version: 3.1.1
- API version: 2026.09.1
- SHA-256: `499b75814a4c391bd640e977a724cb7398a71f31fd60cac39bdc864d916ff978`
- Upstream schema licence: EUPL-1.2, as declared by `info.license`.

The provider implementation cross-checked for prose semantics is
[entur/geocoder revision 72bbd93ba2569393c9a2395e52a4c19b85002b03](https://github.com/entur/geocoder/tree/72bbd93ba2569393c9a2395e52a4c19b85002b03)
(2026-10-16T11:47:56Z). This identifies the reviewed source; it does not establish
the deployed API revision or that the published schema was built from that commit.

`LICENSE.EUPL-1.2` retains the upstream licence text from that revision's
[LICENSE.md](https://github.com/entur/geocoder/blob/72bbd93ba2569393c9a2395e52a4c19b85002b03/LICENSE.md).
Generated contracts retain the schema's provenance separately from the Orval
generator's licence and this private package's handwritten code. These notices do
not establish hosted-service permission or the licences and required attribution
of returned supplier data.

Generation and check mode verify the pinned SHA-256, use the local snapshot and
never fetch a schema.
To refresh deliberately, review the upstream document and semantic changes, copy
the exact approved bytes, update this provenance and the generator hash pin, and regenerate with
`pnpm entur-geocoder:generate`. Verify both consumers before accepting a refresh.
