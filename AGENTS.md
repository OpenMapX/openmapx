# OpenMapX coding-agent instructions

## Integration changes

Read the [integration system](docs/docs/developer/integration-system.md) for host,
provider and attribution contracts. Use the [built-in integration guide](docs/docs/developer/writing-an-integration.md)
for in-tree features and the [external extension guide](docs/docs/developer/building-an-external-extension.md)
for installed community extensions; these have different execution and trust boundaries.

- Access host services through `IntegrationContext`. Use its HTTP client for provider
  requests and `upstreamRuntime` for quota-bound acquisition; preserve source-policy controls.
- Keep integrations' web-host imports within the focused `@/integration-api/...` surface.
- For statically declared upstreams, update manifest source/privacy metadata and
  source-ID-keyed localized disclosures together. Credit the sources that supplied the result.

## API changes

Read the [API surface contract](docs/docs/developer/api-surface.md) before changing
routes, authentication declarations or request/response schemas.

- Register core routes through `registerCoreRoutes`. Keep `declareRouteAuth` beside the
  runtime guard it documents; that helper records metadata and does not enforce access.
- Integration `registerRoute` calls need literal method and path strings for static extraction.
- Regenerate the committed OpenAPI document with route changes and inspect its diff.
  Fastify response schemas alter serialization and can drop undeclared fields, so verify
  client-visible behavior when adding or changing them.

## Host operations

Keep application services' Docker and host operations behind typed ops-agent operations.
Docker sockets and registry credentials belong to that service, as enforced by the
[host-authority gate](scripts/check-ops-authority.ts). For service definitions and
configuration changes, follow the [service manifest contract](docs/docs/developer/service-manifest.md).

## Verification

Select checks and shared test fixtures from [Contributing: Quality bar](CONTRIBUTING.md#quality-bar)
and the affected packages' current scripts. Verify the affected runtime and report which
checks ran, including any database, browser or native-device verification left unperformed.
