import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUBJECT_DATA_CATALOGUE } from "../apps/api/src/privacy/catalogue";
import type { SubjectDataRegistration, SubjectLocatorType } from "../packages/core/src/privacy";
import { serviceManifestSchema } from "../packages/core/src/services/manifest-schema";
import { integrationManifestSchema } from "../packages/integration-framework/src/manifest";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOGUE_IDS = new Set(SUBJECT_DATA_CATALOGUE.map((item) => item.id));

/** Direct user FKs are intentionally explicit: this list is the static half
 * of the live PostgreSQL inventory in user-erasure-postgres.test.ts. */
export const DIRECT_USER_FK_CLASSIFICATIONS: Record<string, string> = {
  "account.user_id": "auth-accounts",
  "account_action_receipt.actor_id": "administrative-receipts",
  "account_action_receipt.target_id": "administrative-receipts",
  "account_mail_outbox.user_id": "auth-verifications",
  "data_disclosure_event.user_id": "disclosure-events",
  "admin_audit_log.actor_id": "admin-audit-attribution",
  "auth_policy_application.actor_id": "administrative-receipts",
  "auth_policy_state.activated_by": "admin-audit-attribution",
  "admin_job.created_by": "admin-jobs-attribution",
  "installed_extension.installed_by": "installed-component-attribution",
  "installed_integration.installed_by": "installed-component-attribution",
  "integration_application_receipt.actor_id": "administrative-receipts",
  "integration_secret.updated_by": "secret-update-attribution",
  "labeled_place.user_id": "labeled-places",
  "mangrove_keypair.user_id": "mangrove-keypairs",
  "mobile_auth_handoff.user_id": "mobile-auth-handoffs",
  "oauth_access_token.user_id": "auth-oauth-tokens",
  "oauth_client.user_id": "auth-oauth-resources",
  "oauth_consent.user_id": "auth-oauth-resources",
  "oauth_refresh_token.user_id": "auth-oauth-tokens",
  "parked_location.user_id": "parked-locations",
  "platform_configuration_preview.actor_id": "platform-configuration-previews",
  "passkey.user_id": "auth-passkeys",
  "personal_timeline_connection.user_id": "timeline-connections",
  "personal_vehicle.user_id": "personal-vehicles",
  "saved_list.user_id": "saved-lists",
  "service_secret.updated_by": "secret-update-attribution",
  "system_secret.updated_by": "secret-update-attribution",
  "transit_credential_preview.actor_id": "secret-update-attribution",
  "configuration_migration_preview.actor_id": "secret-update-attribution",
  "session.user_id": "auth-sessions",
  "admin_action_reauthentication.actor_id": "auth-sessions",
  "share_link.user_id": "share-links",
  "two_factor.user_id": "auth-two-factor",
  "data_subject_request.user_id": "privacy-case-records",
  "data_subject_request.actor_user_id": "privacy-case-handling-attribution",
  "data_subject_request_notification.recipient_user_id": "privacy-case-handling-attribution",
  "data_subject_request_event.actor_user_id": "privacy-case-handling-attribution",
  "admin_audit_log.target_user_id": "admin-audit-attribution",
  "system_settings.updated_by": "system-setting-attribution",
  "session_auth_assurance.user_id": "auth-sessions",
};

/** Columns that hold an account's id, or a value derived from it, without a
 * direct foreign key to "user", and what removes it when the account is
 * deleted. "Erasure trigger" is `openmapx_erase_user_residue()`, which runs
 * on every delete of a "user" row. The live catalog test in
 * user-erasure-postgres.test.ts refuses any other such column. */
export const USER_ID_COLUMNS_WITHOUT_USER_FOREIGN_KEY: Record<string, string> = {
  "admin_audit_log.target_id": "erasure trigger: set to NULL where target_type is 'user'",
  "admin_action_reauthentication.target_id":
    "erasure trigger: the row is deleted for an account.* purpose",
  "session.impersonated_by": "erasure trigger: the impersonation sessions are deleted",
  "verification.identifier": "erasure trigger: the rows naming the email are deleted",
  "verification.value": "erasure trigger: the rows holding the id are deleted",
  "data_manager.jobs.triggered_by": "erasure trigger: 'api:user:<id>' is set to NULL",
  "data_manager.offline_package_job_owners.principal":
    "API delete hook (HMAC of the id under an API-only key); otherwise retention",
  "data_manager.offline_package_artifact_references.principal":
    "API delete hook (HMAC of the id under an API-only key); otherwise retention",
  "mangrove_keypair_wrap.user_id": "foreign key CASCADE to mangrove_keypair.user_id",
};

/** Columns whose name looks like an account reference but holds none. */
export const NON_USER_ID_COLUMNS: Record<string, string> = {
  "share_link.target_id": "a saved list or route; the row cascades with share_link.user_id",
  "personal_timeline_connection.upstream_user_id":
    "the account in the external Dawarich instance; the row cascades",
  "data_disclosure_event.recipient_id": "the third party that received a disclosure",
  "data_manager.offline_package_jobs.lease_owner": "a worker",
};

const MANIFEST_SUBJECT_TYPES = ["integration", "service"] as const;
type ManifestSubjectType = (typeof MANIFEST_SUBJECT_TYPES)[number];

export interface ManifestSubjectFixture {
  source: ManifestSubjectType;
  id: string;
  subjectData:
    | {
        storesPersonalData: boolean;
        strategy: "collector" | "operator_task" | "not_personal";
        registrationIds: string[];
        operatorInstructions: string | null;
      }
    | undefined;
}

export interface SubjectDataInventoryOverrides {
  catalogue?: readonly SubjectDataRegistration[];
  directUserForeignKeys?: string[];
  directUserForeignKeyClassifications?: Record<string, string>;
  manifestSubjects?: ManifestSubjectFixture[];
}

/** Locators whose field holds an account's id. */
const ACCOUNT_ID_LOCATOR_TYPES = new Set<SubjectLocatorType>([
  "user_id",
  "actor_id",
  "target_id",
  "creator_id",
  "updater_id",
  "triggered_by",
]);

export interface SubjectDataInventoryResult {
  errors: string[];
  warnings: string[];
  checked: { registrations: number; manifests: number; directUserForeignKeys: number };
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function collectManifestSubjects(): { subjects: ManifestSubjectFixture[]; errors: string[] } {
  const subjects: ManifestSubjectFixture[] = [];
  const errors: string[] = [];
  for (const [rootName, filename, source] of [
    ["integrations", "manifest.json", "integration"],
    ["services", "service.json", "service"],
  ] as const) {
    const root = join(ROOT, rootName);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const path = join(root, entry.name, filename);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const raw = readJson(path);
      if (!raw || typeof raw !== "object") {
        errors.push(`${rootName}/${entry.name}: invalid JSON`);
        continue;
      }
      const schema = source === "integration" ? integrationManifestSchema : serviceManifestSchema;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        errors.push(
          `${rootName}/${entry.name}: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
        );
        continue;
      }
      subjects.push({ source, id: entry.name, subjectData: parsed.data.subjectData });
    }
  }
  return { subjects, errors };
}

function collectDirectUserForeignKeys(): string[] {
  // Keep the inventory deterministic and reviewable.  The companion live
  // PostgreSQL test obtains the actual deployed FK graph; this static map is
  // the checked-in schema contract and deliberately fails when a new key is
  // added without a matching catalogue entry.
  return Object.keys(DIRECT_USER_FK_CLASSIFICATIONS).sort();
}

export function validateSubjectDataInventory(
  overrides: SubjectDataInventoryOverrides = {},
): SubjectDataInventoryResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const duplicateIds = SUBJECT_DATA_CATALOGUE.map((item) => item.id).filter(
    (id, index, list) => list.indexOf(id) !== index,
  );
  for (const id of duplicateIds) errors.push(`catalogue: duplicate registration id ${id}`);
  const accountColumns = new Set([
    ...Object.keys(DIRECT_USER_FK_CLASSIFICATIONS),
    ...Object.keys(USER_ID_COLUMNS_WITHOUT_USER_FOREIGN_KEY),
  ]);
  for (const registration of overrides.catalogue ?? SUBJECT_DATA_CATALOGUE) {
    if (registration.strategy === "collector" && !registration.collectorId) {
      errors.push(`catalogue: collector registration ${registration.id} has no collectorId`);
    }
    // A database locator of an account id names a column of the inventory
    // below, or the account's own key.
    if (registration.source !== "openmapx-db") continue;
    for (const { type, field } of registration.locators) {
      if (ACCOUNT_ID_LOCATOR_TYPES.has(type) && field !== "user.id" && !accountColumns.has(field))
        errors.push(
          `catalogue: ${registration.id} locates ${field}, which is no known account column`,
        );
    }
  }

  const discovered = collectManifestSubjects();
  errors.push(...discovered.errors);
  const manifests = overrides.manifestSubjects ?? discovered.subjects;
  for (const manifest of manifests) {
    const subjectData = manifest.subjectData;
    // An integration that stores no personal data leaves the declaration out;
    // every service declares it.
    if (!subjectData) {
      if (manifest.source === "service") {
        errors.push(`${manifest.source}/${manifest.id}: missing subjectData declaration`);
      }
      continue;
    }
    for (const id of subjectData.registrationIds) {
      if (!CATALOGUE_IDS.has(id))
        errors.push(`${manifest.source}/${manifest.id}: unknown subject registration ${id}`);
    }
    if (subjectData.storesPersonalData && subjectData.strategy === "not_personal") {
      errors.push(`${manifest.source}/${manifest.id}: personal data cannot be not_personal`);
    }
    if (
      !subjectData.storesPersonalData &&
      (subjectData.registrationIds.length || subjectData.operatorInstructions)
    ) {
      errors.push(
        `${manifest.source}/${manifest.id}: non-personal declaration has subject metadata`,
      );
    }
    if (
      subjectData.storesPersonalData &&
      subjectData.strategy === "collector" &&
      !subjectData.registrationIds.length
    ) {
      errors.push(
        `${manifest.source}/${manifest.id}: collector declaration has no registrationIds`,
      );
    }
    if (
      subjectData.storesPersonalData &&
      subjectData.strategy === "operator_task" &&
      !subjectData.operatorInstructions
    ) {
      errors.push(
        `${manifest.source}/${manifest.id}: operator_task declaration needs instructions`,
      );
    }
  }

  const direct = overrides.directUserForeignKeys ?? collectDirectUserForeignKeys();
  const classifications =
    overrides.directUserForeignKeyClassifications ?? DIRECT_USER_FK_CLASSIFICATIONS;
  // The registrations whose locators name each column; a column one of them
  // locates must be classified under it, not merely under some registration.
  const locatedBy = new Map<string, string[]>();
  for (const registration of overrides.catalogue ?? SUBJECT_DATA_CATALOGUE)
    for (const { field } of registration.locators)
      locatedBy.set(field, [...(locatedBy.get(field) ?? []), registration.id]);
  for (const foreignKey of direct) {
    const registrationId = classifications[foreignKey];
    const owners = locatedBy.get(foreignKey);
    if (!registrationId) {
      errors.push(`direct user foreign key ${foreignKey} has no erasure/catalogue classification`);
    } else if (!CATALOGUE_IDS.has(registrationId)) {
      errors.push(
        `direct user foreign key ${foreignKey} references missing registration ${registrationId}`,
      );
    } else if (owners && !owners.includes(registrationId)) {
      errors.push(
        `direct user foreign key ${foreignKey} is classified under ${registrationId}, but the catalogue locates it under ${owners.join(", ")}`,
      );
    } else if (!owners) {
      // A classified column no registration locates is left out of every
      // export, however complete the classification looks.
      errors.push(
        `direct user foreign key ${foreignKey} is classified under ${registrationId}, which does not locate it`,
      );
    }
  }
  const reserved = [
    ["data_subject_request", "privacy-case-records"],
    ["data_disclosure_event", "disclosure-events"],
  ] as const;
  const schemaText = readFileSync(join(ROOT, "apps/api/src/db/schema.ts"), "utf8");
  for (const [table, registrationId] of reserved) {
    if (schemaText.includes(table) && !CATALOGUE_IDS.has(registrationId)) {
      errors.push(`reserved privacy table ${table} has no registration ${registrationId}`);
    }
  }
  if (SUBJECT_DATA_CATALOGUE.some((item) => item.strategy === "operator_task")) {
    warnings.push("operator-task sources require caseworker review before an export is generated");
  }
  return {
    errors,
    warnings,
    checked: {
      registrations: SUBJECT_DATA_CATALOGUE.length,
      manifests: manifests.length,
      directUserForeignKeys: direct.length,
    },
  };
}

export function main(): void {
  const result = validateSubjectDataInventory();
  if (result.errors.length) {
    console.error(`✖ Subject data catalogue: ${result.errors.length} issue(s)`);
    for (const error of result.errors) console.error(`  • ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `✓ Subject data catalogue: ${result.checked.registrations} registrations, ${result.checked.manifests} manifests, ${result.checked.directUserForeignKeys} direct user FKs classified.`,
  );
  for (const warning of result.warnings) console.log(`  note: ${warning}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
