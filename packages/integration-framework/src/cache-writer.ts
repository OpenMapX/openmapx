/**
 * The fenced cache writer lives in mobility-core so shared mobility code, which
 * cannot depend on the framework, uses the same implementation.
 */
export { type CacheWriter, captureCacheWriter } from "@openmapx/mobility-core/cache";
