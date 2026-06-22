# @openmapx/extension-sdk

The public authoring surface for OpenMapX integrations. This package provides the curated, prebuilt, Apache-2.0 subset of the integration contract types and helpers needed to build and type-check an OpenMapX integration outside the monorepo.

## Install

```sh
npm i -D @openmapx/extension-sdk
```

## Usage

```ts
import type { IntegrationContext } from "@openmapx/extension-sdk";
import { freshnessNow, withAttribution } from "@openmapx/extension-sdk";

export async function setup(ctx: IntegrationContext): Promise<void> {
  ctx.registerTransitProvider({
    id: "my-transit",
    async tripPlan(request) {
      const data = await ctx.http.get("https://api.example.com/trips");
      return withAttribution(data, [{ sourceId: "my-source", name: "My Source" }], freshnessNow());
    },
  });
}
```

## Runtime externals

`@openmapx/integration-framework` is injected by the host at runtime and must be declared as a build-time external in your integration's bundler config. It is NOT a peer dependency of this SDK — the SDK inlines the types at build time. Your bundler external list should include:

- `@openmapx/core`
- `@openmapx/core/server`
- `@openmapx/integration-framework`
- `@openmapx/place-ids`

## Testing

```ts
import { createMockIntegrationContext } from "@openmapx/extension-sdk/testing";

const ctx = createMockIntegrationContext({ config: { apiKey: "test" } });
await setup(ctx);
// assert on ctx.registered.transit, etc.
```
