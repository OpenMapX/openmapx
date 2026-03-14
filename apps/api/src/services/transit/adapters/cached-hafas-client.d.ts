declare module "cached-hafas-client" {
  export const CACHED: unique symbol;
  export const TIME: unique symbol;

  // biome-ignore lint/suspicious/noExplicitAny: external untyped package
  export function createCachedHafasClient(hafas: any, storage: any, opt?: any): any;
}

declare module "cached-hafas-client/stores/redis.js" {
  // biome-ignore lint/suspicious/noExplicitAny: external untyped package
  export function createRedisStore(db: any): any;
}
