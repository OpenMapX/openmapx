// Re-exported from `@openmapx/core` so CLI consumers can keep importing from
// the local `lib/paths` path. The implementation lives in core because
// apps/api also depends on it — single source of truth for repo-root
// detection.
export { findRepoRoot, type RepoPaths, repoPaths } from "@openmapx/core";
