declare module "db-vendo-client" {
  // biome-ignore lint/suspicious/noExplicitAny: external untyped package
  export function createClient(profile: any, userAgent: string, opt?: Record<string, any>): any;
}

declare module "db-vendo-client/p/db/index.js" {
  export const profile: unknown;
}
