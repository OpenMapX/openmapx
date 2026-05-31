// Ambient declaration for `db-vendo-client`, which ships no type declarations
// at all (TS7016). Only the bare-package `createClient` import in provider.ts
// needs typing — its subpath imports (`/p/dbnav/index.js`, `/retry.js`, …) are
// individually marked `@ts-expect-error` there. Mirrors the equivalent decl in
// apps/api/src/services/transit/adapters/db-vendo-client.d.ts so the same
// runtime module is typed consistently in both type-check passes.
declare module "db-vendo-client" {
  // biome-ignore lint/suspicious/noExplicitAny: external untyped package
  export function createClient(profile: any, userAgent: string, opt?: Record<string, any>): any;
}
