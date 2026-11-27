import {
  type SubjectDataRegistration,
  subjectDataRegistrationSchema,
  validateSubjectDataRegistrations,
} from "@openmapx/core/privacy";
import { integrationSubjectDataSchema } from "@openmapx/extension-contracts/integration";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import z from "zod/v4";
import {
  installedIntegrations,
  runningSubjectDataHandler,
  subjectDataLog,
} from "./extension-handlers";

/**
 * The explicit controller catalogue.  Keep this list hand-maintained: a table
 * name or manifest reflection is not a legal classification.  New persisted
 * subject data must add a registration and a collector/task before it can be
 * presented as complete.
 */
const registrationDefinitions: SubjectDataRegistration[] = [
  {
    id: "account-profile",
    version: 1,
    category: "account",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-account",
    locators: [{ type: "user_id", field: "user.id" }],
    purposes: ["account-management", "authentication"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-provided" },
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "include", format: "json" },
    secretPolicy: { mode: "metadata", code: "account-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-accounts",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [{ type: "user_id", field: "account.user_id" }],
    purposes: ["authentication", "security-and-abuse-prevention"],
    legalBases: ["contract", "legal-obligation"],
    origin: { kind: "processor", descriptionCode: "authentication-provider" },
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [
      { id: "openmapx-controller", roleCode: "controller", country: "DE" },
      { id: "openstreetmap", roleCode: "independent-controller" },
      { id: "mapillary", roleCode: "independent-controller", country: "US" },
    ],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "credential-material" },
    secretPolicy: { mode: "redact", code: "credential-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-sessions",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [
      { type: "user_id", field: "session.user_id" },
      // How the session was signed in to; deleted with its session.
      { type: "user_id", field: "session_auth_assurance.user_id" },
      { type: "actor_id", field: "admin_action_reauthentication.actor_user_id" },
    ],
    purposes: ["authentication", "security-and-abuse-prevention"],
    legalBases: ["contract", "legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "service-generated" },
    // The API's daily retention deletes them 30 days after they expire.
    retention: {
      kind: "fixed-days",
      days: 30,
      daysAfterClosure: 30,
      reasonCode: "session-expiry",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "security-metadata" },
    secretPolicy: { mode: "redact", code: "session-token-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-verifications",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [
      { type: "exact_identifier", field: "verification.identifier", format: "email-or-purpose" },
      { type: "user_id", field: "account_mail_outbox.user_id" },
    ],
    purposes: ["authentication", "account-management"],
    legalBases: ["contract"],
    origin: { kind: "controller", descriptionCode: "service-generated" },
    retention: {
      kind: "ephemeral",
      hours: 48,
      daysAfterClosure: 0,
      reasonCode: "challenge-expiry",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "challenge-material" },
    secretPolicy: { mode: "redact", code: "challenge-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-passkeys",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [{ type: "user_id", field: "passkey.user_id" }],
    purposes: ["authentication", "security-and-abuse-prevention"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "passkey-registration" },
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "authentication-key-metadata" },
    secretPolicy: { mode: "metadata", code: "passkey-public-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-two-factor",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [{ type: "user_id", field: "two_factor.user_id" }],
    purposes: ["authentication", "security-and-abuse-prevention"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "security-setting" },
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "authentication-secret" },
    secretPolicy: { mode: "metadata", code: "two-factor-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-oauth-resources",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [
      { type: "user_id", field: "oauth_client.user_id" },
      { type: "user_id", field: "oauth_consent.user_id" },
    ],
    purposes: ["authentication", "service-provisioning"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "oauth-registration" },
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "authorization-secret" },
    secretPolicy: { mode: "redact", code: "oauth-secret-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "auth-oauth-tokens",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [
      { type: "user_id", field: "oauth_refresh_token.user_id" },
      { type: "user_id", field: "oauth_access_token.user_id" },
    ],
    purposes: ["authentication", "security-and-abuse-prevention"],
    legalBases: ["contract"],
    origin: { kind: "controller", descriptionCode: "service-generated" },
    // The API's daily retention deletes them 30 days after they expire.
    retention: {
      kind: "fixed-days",
      days: 30,
      daysAfterClosure: 30,
      reasonCode: "token-expiry",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "authorization-secret" },
    secretPolicy: { mode: "redact", code: "oauth-secret-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "saved-lists",
    version: 1,
    category: "saved-content",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-content",
    locators: [{ type: "user_id", field: "saved_list.user_id" }],
    purposes: ["saved-content", "personalization"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-created" },
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "account-content" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "include", format: "json" },
    secretPolicy: { mode: "metadata", code: "saved-content" },
    rightsOfOthers: { mode: "redact", code: "shared-content-review" },
  },
  {
    id: "saved-places",
    version: 1,
    category: "saved-content",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-content",
    locators: [{ type: "user_id", field: "saved_list.user_id" }],
    purposes: ["saved-content", "navigation"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-created" },
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "account-content" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "include", format: "geojson" },
    secretPolicy: { mode: "metadata", code: "saved-content" },
    rightsOfOthers: { mode: "redact", code: "shared-content-review" },
  },
  {
    id: "labeled-places",
    version: 1,
    category: "saved-content",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-content",
    locators: [{ type: "user_id", field: "labeled_place.user_id" }],
    purposes: ["saved-content", "personalization"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-created" },
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "account-content" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "include", format: "geojson" },
    secretPolicy: { mode: "metadata", code: "saved-content" },
    rightsOfOthers: { mode: "redact", code: "shared-content-review" },
  },
  {
    id: "personal-vehicles",
    version: 1,
    category: "vehicles",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-vehicles",
    locators: [{ type: "user_id", field: "personal_vehicle.user_id" }],
    purposes: ["personalization", "navigation"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-created" },
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "account-content" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "include", format: "json" },
    secretPolicy: { mode: "metadata", code: "vehicle-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "parked-locations",
    version: 1,
    category: "vehicles",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-vehicles",
    locators: [{ type: "user_id", field: "parked_location.user_id" }],
    purposes: ["navigation", "personalization"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-created" },
    // Until the owner clears it; one with a parking time limit is deleted by
    // the API's daily retention 30 days after that limit passes.
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "parking-expiry" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "include", format: "geojson" },
    secretPolicy: { mode: "metadata", code: "location-safe-metadata" },
    rightsOfOthers: { mode: "redact", code: "shared-location-review" },
  },
  {
    id: "share-links",
    version: 1,
    category: "sharing",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-sharing",
    locators: [{ type: "user_id", field: "share_link.user_id" }],
    purposes: ["saved-content", "publication"],
    legalBases: ["contract", "consent"],
    origin: { kind: "subject", descriptionCode: "subject-published" },
    // Until revoked; an expiring link is deleted by the API's daily retention
    // 30 days after it expires.
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "link-expiry" },
    recipients: [
      { id: "openmapx-controller", roleCode: "controller", country: "DE" },
      { id: "public-recipient", roleCode: "public-recipient" },
    ],
    article15: "include",
    portability: { decision: "include", format: "json" },
    secretPolicy: { mode: "redact", code: "share-token-redacted" },
    rightsOfOthers: { mode: "operator_review", code: "shared-content-review" },
  },
  {
    id: "timeline-connections",
    version: 1,
    category: "timeline",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-timeline",
    locators: [{ type: "user_id", field: "personal_timeline_connection.user_id" }],
    purposes: ["timeline-processing", "service-provisioning"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-connected" },
    retention: {
      kind: "account-lifetime",
      daysAfterClosure: 0,
      reasonCode: "connection-revocation",
    },
    recipients: [
      { id: "openmapx-controller", roleCode: "controller", country: "DE" },
      { id: "dawarich-managed", roleCode: "processor", country: "DE" },
    ],
    article15: "include",
    portability: { decision: "include", format: "json" },
    secretPolicy: { mode: "redact", code: "timeline-credential-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "mangrove-keypairs",
    version: 1,
    category: "publication-keys",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-mangrove",
    locators: [{ type: "user_id", field: "mangrove_keypair.user_id" }],
    purposes: ["publication", "security-and-abuse-prevention"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-key" },
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "key-revocation" },
    recipients: [
      { id: "openmapx-controller", roleCode: "controller", country: "DE" },
      { id: "mangrove-reviews", roleCode: "independent-controller" },
    ],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "private-key-material" },
    secretPolicy: { mode: "metadata", code: "public-key-only" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "mobile-auth-handoffs",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-authentication",
    locators: [{ type: "user_id", field: "mobile_auth_handoff.user_id" }],
    purposes: ["authentication"],
    legalBases: ["contract"],
    origin: { kind: "controller", descriptionCode: "service-generated" },
    retention: { kind: "ephemeral", hours: 2, daysAfterClosure: 0, reasonCode: "handoff-expiry" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "authentication-material" },
    secretPolicy: { mode: "redact", code: "handoff-secret-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "admin-audit-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [
      { type: "actor_id", field: "admin_audit_log.actor_user_id" },
      { type: "target_id", field: "admin_audit_log.target_user_id" },
      { type: "actor_id", field: "auth_policy_state.activated_by_user_id" },
    ],
    purposes: ["legal-accountability", "security-and-abuse-prevention"],
    legalBases: ["legal-obligation", "legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    // The API's daily retention deletes entries after retention.auditLogDays
    // (365 by default); the response report states the configured period.
    retention: {
      kind: "fixed-days",
      days: 365,
      daysAfterClosure: 365,
      reasonCode: "accountability",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "legal-accountability" },
    secretPolicy: { mode: "metadata", code: "audit-safe-projection" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    // The idempotency receipts of account, sign-in policy and integration
    // changes an administrator made.
    id: "administrative-receipts",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [
      { type: "actor_id", field: "auth_policy_application.actor_user_id" },
      { type: "actor_id", field: "integration_application_receipt.actor_user_id" },
      { type: "actor_id", field: "account_action_receipt.actor_user_id" },
      { type: "target_id", field: "account_action_receipt.target_user_id" },
    ],
    purposes: ["legal-accountability", "security-and-abuse-prevention"],
    legalBases: ["legal-obligation", "legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    // The API's daily retention deletes them one year after they were made,
    // except the newest receipt for each integration and for each account,
    // which stays until a newer one replaces it.
    retention: {
      kind: "fixed-days",
      days: 365,
      daysAfterClosure: 365,
      reasonCode: "receipt-retention",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "legal-accountability" },
    secretPolicy: { mode: "metadata", code: "audit-safe-projection" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "admin-jobs-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [{ type: "creator_id", field: "admin_job.created_by_user_id" }],
    purposes: ["legal-accountability", "support-and-operations"],
    legalBases: ["legal-obligation", "legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    // The API's daily retention deletes finished jobs after
    // retention.adminJobDays (30 by default); the response report states the
    // configured period.
    retention: {
      kind: "fixed-days",
      days: 30,
      daysAfterClosure: 30,
      reasonCode: "job-retention",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "legal-accountability" },
    secretPolicy: { mode: "operator_review", code: "job-payload-review" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "installed-component-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [
      { type: "creator_id", field: "installed_extension.installed_by_user_id" },
      { type: "creator_id", field: "installed_integration.installed_by_user_id" },
    ],
    purposes: ["service-provisioning", "legal-accountability"],
    legalBases: ["contract", "legal-obligation"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    // The attribution lives on the installed component's row: removing the
    // component deletes it, and deleting the account clears it.
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "administrative-record" },
    secretPolicy: { mode: "metadata", code: "attribution-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "platform-configuration-previews",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [{ type: "actor_id", field: "platform_configuration_preview.actor_user_id" }],
    purposes: ["service-provisioning", "security-and-abuse-prevention"],
    legalBases: ["contract", "legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    retention: {
      kind: "account-lifetime",
      daysAfterClosure: 0,
      reasonCode: "configuration-recovery",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "operator-configuration" },
    secretPolicy: { mode: "metadata", code: "configuration-intent-redacted" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "secret-update-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [
      { type: "updater_id", field: "integration_secret.updated_by_user_id" },
      { type: "updater_id", field: "service_secret.updated_by_user_id" },
      { type: "updater_id", field: "system_secret.updated_by_user_id" },
      { type: "actor_id", field: "transit_credential_preview.actor_user_id" },
      { type: "actor_id", field: "configuration_migration_preview.actor_user_id" },
    ],
    purposes: ["service-provisioning", "security-and-abuse-prevention"],
    legalBases: ["contract", "legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "operator-credential" },
    secretPolicy: { mode: "redact", code: "secret-value-redacted" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "system-setting-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [{ type: "updater_id", field: "system_setting.updated_by_user_id" }],
    purposes: ["service-provisioning", "legal-accountability"],
    legalBases: ["contract", "legal-obligation"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    // The attribution lives on the setting's row: the next change replaces
    // it, and deleting the account clears it.
    retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "operator-configuration" },
    secretPolicy: { mode: "redact", code: "setting-value-redacted" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "data-manager-trigger-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "operator_task",
    locators: [{ type: "actor_id", field: "data_manager.job.triggered_by_user_id" }],
    purposes: ["support-and-operations", "legal-accountability"],
    legalBases: ["legitimate-interest", "legal-obligation"],
    origin: { kind: "controller", descriptionCode: "operator-task" },
    // Deleting the account clears the actor from its jobs through the foreign
    // key; 90 days after a job finished (DATA_MANAGER_JOB_RETENTION_DAYS) it
    // is deleted, or, while data-manager has not swept its records yet, loses
    // its actor.
    retention: {
      kind: "fixed-days",
      days: 90,
      daysAfterClosure: 0,
      reasonCode: "accountability",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "operational-record" },
    secretPolicy: { mode: "operator_review", code: "data-manager-review" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "offline-package-ownership",
    version: 1,
    category: "offline-data",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-offline",
    locators: [
      {
        type: "hmac_principal",
        field: "data_manager.offline_package_job_owner.principal",
        purposeCode: "offline-package",
      },
      {
        type: "hmac_principal",
        field: "data_manager.offline_package_artifact_reference.principal",
        purposeCode: "offline-package",
      },
    ],
    purposes: ["navigation", "service-provisioning"],
    legalBases: ["contract"],
    origin: { kind: "subject", descriptionCode: "subject-requested" },
    // Kept while the account exists: data-manager deletes a job's owner rows
    // with the finished job and a retained package's reference when it evicts
    // or invalidates the package. Deleting an account removes its rows at
    // once. Only the API holds the key that derives the principal, so a
    // restore that replays an erasure, or a new principal key, leaves rows
    // that match no existing account; the API's daily retention deletes those
    // 30 days after they were recorded. The package files are data-manager's
    // area extracts and name no account.
    retention: {
      kind: "account-lifetime",
      daysAfterClosure: 30,
      reasonCode: "offline-package-retention",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "derived-package" },
    secretPolicy: { mode: "metadata", code: "offline-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "application-logs",
    version: 1,
    category: "operational-logs",
    source: "openmapx-db",
    strategy: "operator_task",
    locators: [{ type: "exact_identifier", field: "app_log.metadata.subjectId", format: "uuid" }],
    purposes: ["security-and-abuse-prevention", "support-and-operations"],
    legalBases: ["legitimate-interest", "legal-obligation"],
    origin: { kind: "controller", descriptionCode: "operational-log" },
    retention: { kind: "fixed-days", days: 30, daysAfterClosure: 30, reasonCode: "log-retention" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "operational-log" },
    secretPolicy: { mode: "operator_review", code: "structured-log-review" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    // The erasure trigger records the deleted account's id once for each
    // integration listed with a subject-data handler. The row exists only
    // after the account is gone, so no collector can run for it. It is
    // deleted once the integration's handler has erased the account's data,
    // or when the integration runs without a handler or its data is removed.
    // No legal hold applies and no fixed period, hence `until-erased`.
    id: "extension-erasure-pending",
    version: 1,
    category: "account",
    source: "openmapx-db",
    strategy: "operator_task",
    locators: [{ type: "user_id", field: "subject_erasure_pending.subject_user_id" }],
    purposes: ["account-management", "legal-accountability"],
    legalBases: ["legal-obligation"],
    origin: { kind: "controller", descriptionCode: "service-generated" },
    retention: { kind: "until-erased", reasonCode: "extension-erasure" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "erasure-processing" },
    secretPolicy: { mode: "metadata", code: "account-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "redis-subject-controls",
    version: 1,
    category: "operational-controls",
    source: "redis",
    strategy: "operator_task",
    locators: [{ type: "hmac_principal", field: "redis.namespace", purposeCode: "rate-limit" }],
    purposes: ["security-and-abuse-prevention"],
    legalBases: ["legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "operational-control" },
    retention: { kind: "ephemeral", hours: 24, daysAfterClosure: 0, reasonCode: "control-expiry" },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "security-control" },
    secretPolicy: { mode: "metadata", code: "control-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "managed-dawarich",
    version: 1,
    category: "timeline",
    source: "managed-service",
    strategy: "collector",
    collectorId: "managed-dawarich-v1",
    collectorVersion: 1,
    locators: [
      { type: "managed_oidc_subject", field: "dawarich.users.uid", provider: "openid_connect" },
    ],
    purposes: ["timeline-processing", "service-provisioning"],
    legalBases: ["contract"],
    origin: { kind: "processor", descriptionCode: "managed-dawarich" },
    retention: { kind: "account-lifetime", daysAfterClosure: 0, reasonCode: "processor-retention" },
    recipients: [
      { id: "dawarich-managed", roleCode: "processor", country: "DE" },
      { id: "openmapx-controller", roleCode: "controller", country: "DE" },
    ],
    article15: "include",
    portability: { decision: "include", format: "jsonl" },
    secretPolicy: { mode: "redact", code: "dawarich-secret-redacted" },
    rightsOfOthers: { mode: "operator_review", code: "dawarich-rights-review" },
  },
  {
    id: "privacy-case-records",
    version: 1,
    category: "privacy-rights",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-privacy-case",
    locators: [{ type: "user_id", field: "data_subject_request.user_id" }],
    purposes: ["legal-accountability"],
    legalBases: ["legal-obligation"],
    origin: { kind: "controller", descriptionCode: "rights-request" },
    retention: {
      kind: "fixed-days",
      days: 1095,
      daysAfterClosure: 1095,
      reasonCode: "case-accountability",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "case-accountability" },
    secretPolicy: { mode: "redact", code: "protected-case-detail" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    // What a staff member did on other people's privacy cases, and the case
    // alerts sent to them. The case's subject stays out of the projection.
    // Cases and their events are deleted together, after the configured case
    // retention.
    id: "privacy-case-handling-attribution",
    version: 1,
    category: "administrative-accountability",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-administration",
    locators: [
      { type: "actor_id", field: "data_subject_request.actor_user_id" },
      { type: "actor_id", field: "data_subject_request_event.actor_user_id" },
      { type: "user_id", field: "data_subject_request_notification.recipient_user_id" },
    ],
    purposes: ["legal-accountability"],
    legalBases: ["legal-obligation"],
    origin: { kind: "controller", descriptionCode: "administrative-record" },
    retention: {
      kind: "fixed-days",
      days: 1095,
      daysAfterClosure: 1095,
      reasonCode: "case-accountability",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "legal-accountability" },
    secretPolicy: { mode: "metadata", code: "audit-safe-projection" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "disclosure-events",
    version: 1,
    category: "disclosures",
    source: "openmapx-db",
    strategy: "collector",
    collectorId: "openmapx-disclosures",
    locators: [{ type: "user_id", field: "data_disclosure_event.user_id" }],
    purposes: ["legal-accountability", "communications", "publication"],
    legalBases: ["legal-obligation"],
    origin: { kind: "controller", descriptionCode: "disclosure-ledger" },
    // The API's daily retention deletes them three years after they occurred.
    retention: {
      kind: "fixed-days",
      days: 1095,
      daysAfterClosure: 1095,
      reasonCode: "recipient-accountability",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "recipient-information" },
    secretPolicy: { mode: "metadata", code: "disclosure-safe-metadata" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "backup-retained-copies",
    version: 1,
    category: "backup-copies",
    source: "operator",
    strategy: "operator_task",
    locators: [
      { type: "manual", field: "backup.snapshot", instructionsCode: "backup-manual-restore" },
    ],
    purposes: ["legal-accountability", "security-and-abuse-prevention"],
    legalBases: ["legal-obligation", "legitimate-interest"],
    origin: { kind: "operator", descriptionCode: "retained-backup" },
    retention: {
      kind: "fixed-days",
      days: 30,
      daysAfterClosure: 30,
      reasonCode: "backup-retention",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "retained-copy" },
    secretPolicy: { mode: "operator_review", code: "backup-manual-restore-review" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    id: "off-host-processor-sources",
    version: 1,
    category: "external-processing",
    source: "operator",
    strategy: "operator_task",
    locators: [{ type: "manual", field: "operator.source", instructionsCode: "processor-review" }],
    purposes: ["support-and-operations", "communications"],
    legalBases: ["contract", "legal-obligation"],
    origin: { kind: "operator", descriptionCode: "operator-managed-source" },
    retention: {
      kind: "fixed-days",
      days: 1095,
      daysAfterClosure: 1095,
      reasonCode: "case-accountability",
    },
    recipients: [{ id: "openmapx-controller", roleCode: "controller", country: "DE" }],
    article15: "include",
    portability: { decision: "exclude", reasonCode: "operator-source" },
    secretPolicy: { mode: "operator_review", code: "processor-review-required" },
    rightsOfOthers: { mode: "operator_review", code: "rights-of-others" },
  },
  {
    // Better Auth records each OAuth client assertion it accepts so that it
    // cannot be replayed. The record names the client, not a person. The
    // API's daily retention deletes it 30 days after it expires.
    id: "oauth-client-assertions",
    version: 1,
    category: "authentication",
    source: "openmapx-db",
    strategy: "not_personal",
    locators: [],
    purposes: ["security-and-abuse-prevention"],
    legalBases: ["legitimate-interest"],
    origin: { kind: "controller", descriptionCode: "service-generated" },
    retention: {
      kind: "fixed-days",
      days: 30,
      daysAfterClosure: 0,
      reasonCode: "assertion-expiry",
    },
    recipients: [],
    article15: "not_personal",
    portability: { decision: "exclude", reasonCode: "replay-protection" },
    secretPolicy: { mode: "redact", code: "not-personal" },
    rightsOfOthers: { mode: "none" },
  },
  {
    id: "global-public-data",
    version: 1,
    category: "public-data",
    source: "openmapx-db",
    strategy: "not_personal",
    locators: [],
    purposes: ["navigation"],
    legalBases: ["legitimate-interest"],
    origin: { kind: "public-source", descriptionCode: "public-data" },
    retention: { kind: "fixed-days", days: 365, daysAfterClosure: 0, reasonCode: "public-dataset" },
    recipients: [],
    article15: "not_personal",
    portability: { decision: "exclude", reasonCode: "global-public-data" },
    secretPolicy: { mode: "redact", code: "not-personal" },
    rightsOfOthers: { mode: "none" },
  },
];

const deploymentRecipientIds = new Set(["openmapx-controller", "dawarich-managed"]);
const registrations = registrationDefinitions.map((registration) => ({
  ...registration,
  recipients: registration.recipients.map((recipient) => {
    if (!deploymentRecipientIds.has(recipient.id)) return recipient;
    const { country: _deploymentSpecificCountry, ...portableRecipient } = recipient;
    return portableRecipient;
  }),
}));

const validation = validateSubjectDataRegistrations(registrations);
if (!validation.success) {
  throw new Error(`Invalid privacy catalogue: ${validation.error.message}`);
}

export const SUBJECT_DATA_CATALOGUE = Object.freeze(validation.data);
export const SUBJECT_DATA_CATALOGUE_BY_ID = new Map(
  SUBJECT_DATA_CATALOGUE.map((registration) => [registration.id, registration]),
);

export function getSubjectDataRegistration(id: string): SubjectDataRegistration | undefined {
  return SUBJECT_DATA_CATALOGUE_BY_ID.get(id);
}

export function assertSubjectDataRegistration(value: unknown): SubjectDataRegistration {
  return subjectDataRegistrationSchema.parse(value);
}

/** IDs with a code path in the current release. Other collector registrations
 * remain visible but stay unavailable until their source plan is enabled. */
export const AVAILABLE_SUBJECT_COLLECTORS = new Set([
  "openmapx-account",
  "openmapx-authentication",
  "openmapx-content",
  "openmapx-vehicles",
  "openmapx-sharing",
  "openmapx-timeline",
  "openmapx-mangrove",
  "openmapx-administration",
  "openmapx-offline",
  "openmapx-privacy-case",
  "openmapx-disclosures",
  "managed-dawarich-v1",
]);

const EXTENSION_COLLECTOR_PREFIX = "extension:";

/** A registration an installed integration declared in its manifest. */
interface ExtensionCatalogueEntry {
  integrationId: string;
  registration: SubjectDataRegistration;
  title?: string;
  description?: string;
}

const entryTextSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2_000).optional(),
});

/** Keys an extension's entry may not set: the host sets them. */
const HOST_SET_KEYS = ["source", "collectorId"] as const;

/** Each integration's valid entries with their index, and the indexes already warned about. */
const declaredEntries = new WeakMap<
  LoadedIntegration,
  { entries: Array<{ index: number; entry: ExtensionCatalogueEntry }>; warned: Set<number> }
>();

function warnLeftOut(integrationId: string, index: number, problem: string): void {
  subjectDataLog().warn(
    { integrationId, index, problem },
    `Integration ${integrationId}: personal-data registration ${index} is left out of the catalogue`,
  );
}

/**
 * The registrations an installed integration's manifest declares, each
 * checked with the catalogue's own schema; the host sets `source` and
 * `collectorId`. They are read from the declaration as its schema parses it,
 * so a key the schema drops, such as `__proto__`, never reaches the check.
 * An entry that fails is left out with one warning per integration record.
 */
function declaredBy(integration: LoadedIntegration): {
  entries: Array<{ index: number; entry: ExtensionCatalogueEntry }>;
  warned: Set<number>;
} {
  const cached = declaredEntries.get(integration);
  if (cached) return cached;
  const result = {
    entries: [] as Array<{ index: number; entry: ExtensionCatalogueEntry }>,
    warned: new Set<number>(),
  };
  declaredEntries.set(integration, result);
  // Built-in integrations register in the static catalogue.
  if (integration.isBuiltIn) return result;
  const declaration = (integration.manifest as { subjectData?: unknown }).subjectData;
  if (declaration === undefined) return result;
  const parsed = integrationSubjectDataSchema.safeParse(declaration);
  if (!parsed.success) return result;
  for (const [index, raw] of (parsed.data.registrations ?? []).entries()) {
    const refuse = (problem: string) => {
      result.warned.add(index);
      warnLeftOut(integration.id, index, problem);
    };
    const hostSet = HOST_SET_KEYS.filter((key) => Object.hasOwn(raw, key));
    if (hostSet.length > 0) {
      refuse(`sets ${hostSet.join(" and ")}, which the host sets`);
      continue;
    }
    const { title, description, ...fields } = raw;
    const text = entryTextSchema.safeParse({ title, description });
    if (!text.success) {
      refuse("title or description is not a text of the allowed length");
      continue;
    }
    if (fields.strategy === "not_personal") {
      refuse("an extension declares only personal data");
      continue;
    }
    // A collector needs a collector id to pass the schema; the host's own
    // id, which the schema's grammar does not admit, replaces it afterwards.
    const checked = subjectDataRegistrationSchema.safeParse({
      ...fields,
      source: "extension",
      ...(fields.strategy === "collector" ? { collectorId: "extension" } : {}),
    });
    if (!checked.success) {
      refuse(checked.error.issues.map((issue) => issue.path.join(".") || "entry").join(", "));
      continue;
    }
    result.entries.push({
      index,
      entry: {
        integrationId: integration.id,
        registration: {
          ...checked.data,
          collectorId: `${EXTENSION_COLLECTOR_PREFIX}${integration.id}`,
        },
        ...(text.data.title === undefined ? {} : { title: text.data.title }),
        ...(text.data.description === undefined ? {} : { description: text.data.description }),
      },
    });
  }
  return result;
}

/**
 * The entries every installed integration in the registry declares, loaded
 * or not, after the static catalogue's ids and those of earlier entries: a
 * duplicate id is left out with a warning.
 */
function extensionCatalogueEntries(): ExtensionCatalogueEntry[] {
  const taken = new Set(SUBJECT_DATA_CATALOGUE_BY_ID.keys());
  const accepted: ExtensionCatalogueEntry[] = [];
  for (const integration of installedIntegrations() ?? []) {
    const declared = declaredBy(integration);
    for (const { index, entry } of declared.entries) {
      if (taken.has(entry.registration.id)) {
        if (!declared.warned.has(index)) {
          declared.warned.add(index);
          warnLeftOut(integration.id, index, `the id ${entry.registration.id} is taken`);
        }
        continue;
      }
      taken.add(entry.registration.id);
      accepted.push(entry);
    }
  }
  return accepted;
}

/**
 * The static catalogue followed by the registrations installed integrations
 * declare, with `source: "extension"` and `collectorId: "extension:<id>"`.
 * `SUBJECT_DATA_CATALOGUE` stays the static part, which the repository's
 * checks validate.
 */
export function subjectDataCatalogue(): readonly SubjectDataRegistration[] {
  return [
    ...SUBJECT_DATA_CATALOGUE,
    ...extensionCatalogueEntries().map(({ registration }) => registration),
  ];
}

/** Title and description an extension gave its registration `id`, if one declared it. */
export function extensionRegistrationText(
  id: string,
): { title?: string; description?: string } | undefined {
  const entry = extensionCatalogueEntries().find(({ registration }) => registration.id === id);
  return entry && { title: entry.title, description: entry.description };
}

export function catalogueAvailability(
  registration: SubjectDataRegistration,
): "available" | "unavailable" | "operator_review" | "not_applicable" {
  // Only the host sets this prefix; the schema's grammar refuses it elsewhere.
  if (registration.collectorId?.startsWith(EXTENSION_COLLECTOR_PREFIX)) {
    const integrationId = registration.collectorId.slice(EXTENSION_COLLECTOR_PREFIX.length);
    const integration = installedIntegrations()?.find(({ id }) => id === integrationId);
    return integration && runningSubjectDataHandler(integration) ? "available" : "unavailable";
  }
  if (registration.strategy === "not_personal") return "not_applicable";
  if (registration.strategy === "operator_task") return "operator_review";
  return registration.collectorId && AVAILABLE_SUBJECT_COLLECTORS.has(registration.collectorId)
    ? "available"
    : "unavailable";
}
