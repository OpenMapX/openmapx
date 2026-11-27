// The private workspace packages whose code and declarations the published SDK
// may carry. All of them are Apache-2.0 like the SDK; an AGPL-3.0 package must
// never be listed. Both builds read this list, so a package left out stays an
// import, which `scripts/check-external-consumer.mjs` refuses.
export const INLINED_WORKSPACE_PACKAGES =
  /^@openmapx\/(integration-framework|core|mobility-core|mobility-formats|place-ids|air-quality|provider-kit|transitous-core|motis-feed-proxy-config)(\/|$)/;
