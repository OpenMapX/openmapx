/**
 * Immutable revision of the public-transport/transport-apis catalog this
 * integration consumes. The catalog's `options.endpoint` values become
 * server-side POST targets, so the runtime must never follow a moving branch.
 * Mirrors the MobilityData GBFS pin; bumped by `pnpm openmapx transit-registry
 * bump` and kept in sync with infra/docker/transport-apis.lock.json by
 * `pnpm check-toolchain-pins`.
 */
export const TRANSPORT_APIS_REPO = "public-transport/transport-apis";

/** Branch the pinned commit was taken from — recorded for bump diffs only. */
export const TRANSPORT_APIS_REF = "v1";

/** 40-hex commit SHA. Never hand-edit; use the bump command. */
export const TRANSPORT_APIS_COMMIT = "58aec5b1b7c876f133c9d1336739d0f61211b74e";

/** ISO-8601 timestamp of the last bump, surfaced in startup logs. */
export const TRANSPORT_APIS_LOCKED_AT = "2026-08-02T22:14:09.534Z";

export const TRANSPORT_APIS_JSDELIVR_PKG_URL = `https://data.jsdelivr.com/v1/packages/gh/${TRANSPORT_APIS_REPO}@${TRANSPORT_APIS_COMMIT}`;
export const TRANSPORT_APIS_JSDELIVR_CDN_BASE = `https://cdn.jsdelivr.net/gh/${TRANSPORT_APIS_REPO}@${TRANSPORT_APIS_COMMIT}`;
export const TRANSPORT_APIS_GITHUB_TREE_URL = `https://api.github.com/repos/${TRANSPORT_APIS_REPO}/git/trees/${TRANSPORT_APIS_COMMIT}?recursive=1`;
export const TRANSPORT_APIS_RAW_BASE = `https://raw.githubusercontent.com/${TRANSPORT_APIS_REPO}/${TRANSPORT_APIS_COMMIT}`;
