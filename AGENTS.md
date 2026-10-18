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

## Pull request writing and visual evidence

Use the concise prompts in [Contributing](CONTRIBUTING.md#descriptions-and-visual-evidence).
For every visual/visible-impact change, capture and inspect the actual rendered result,
including docs and other visible output. Put screenshots near the explanation in the PR:
comparable labeled before/after for existing behavior, contextual after views for new
surfaces, and relevant changed states/viewports. Recordings supplement screenshots.

Use `gh pr create/edit --body-file ... --attach ...` to upload images and rewrite
referenced local paths to hosted assets. Inspect the final description and each hosted
image after upload; local paths are not delivered evidence. A partial upload can still
create/edit the PR, so read back its state before retrying. Report unavailable platform
checks accurately; a local preview does not establish native GitHub form acceptance.

Own the accuracy and verification of authorized AI-assisted work. No declaration or
model inventory is required; preserve meaningful provenance and never invent results.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
