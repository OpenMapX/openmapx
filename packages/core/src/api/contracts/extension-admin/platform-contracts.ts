// The API and the ops-agent reach the published extension contracts only
// through this package, so they share one grammar with extension authors.
export type {
  ExtensionConfigEntry,
  ExtensionConfigTarget,
} from "@openmapx/extension-contracts/extension";
export type { ApprovedGrants, GrantId } from "@openmapx/extension-contracts/grants";
export {
  approvedGrantsSchema,
  DATABASE_PRIVILEGE_PATTERN,
  DATABASE_ROLE_NAME_PATTERN,
  DATABASE_SCHEMA_NAME_PATTERN,
  DEVICE_PATH_PATTERN,
  GRANT_ID_MAX_LENGTH,
  grantIdSchema,
  HOST_PATH_MAX_LENGTH,
  HOST_PATH_PATTERN,
  isGrantId,
  isReservedDatabaseName,
  MAX_APPROVED_GRANTS,
  MAX_GRANTS_PER_SERVICE,
  normalizeGrants,
} from "@openmapx/extension-contracts/grants";
