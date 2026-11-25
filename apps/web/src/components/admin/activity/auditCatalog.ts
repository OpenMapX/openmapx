import {
  type AuditAction,
  type AuditTargetType,
  AUDIT_TARGET_TYPES as RECORDED_TARGET_TYPES,
} from "@openmapx/core/api-contracts";

/**
 * Audit actions grouped for the audit filter. The actions and target types
 * come from the API's audit registry; `scripts/admin-code-catalogue.test.ts`
 * fails when this grouping or `adminShared.auditActions` misses a registered
 * action or keeps one the registry does not hold.
 */
export const AUDIT_ACTION_GROUPS: ReadonlyArray<{
  group: string;
  actions: readonly AuditAction[];
}> = [
  {
    group: "integrations",
    actions: [
      "integration.config.update",
      "integration.enable",
      "integration.disable",
      "integration.reload",
      "integration.reload_all",
      "integration.binding.set",
      "integration.binding.remove",
      "standalone.preview",
      "standalone.install",
      "standalone.remove",
      "provider.reset",
    ],
  },
  {
    group: "credentials",
    actions: [
      "integration.credential.set",
      "integration.credential.delete",
      "credential.export",
      "credential.import.preview",
      "credential.import",
    ],
  },
  {
    group: "services",
    actions: [
      "service.start",
      "service.stop",
      "service.restart",
      "service.apply",
      "service.update",
      "service.build",
      "service.selection.update",
      "service.config.update",
      "service.credential.set",
      "service.credential.delete",
      "service.health.check",
      "service.image.pull",
      "service.log.read",
      "compose.render",
    ],
  },
  {
    group: "data",
    actions: [
      "data.operation.run",
      "ambient_places.build",
      "ambient_places.resume",
      "ambient_places.discard",
      "ambient_places.enabled.set",
      "ambient_places.rollback",
    ],
  },
  {
    group: "backups",
    actions: ["backup.create", "backup.restore", "backup.delete", "backup.prune"],
  },
  {
    group: "settings",
    actions: [
      "setting.update",
      "setting.test_email.send",
      "configuration.migration.apply",
      "platform.configuration.save",
      "auth.policy.apply",
      "release.clear",
      "cache.clear",
    ],
  },
  {
    group: "extensions",
    actions: [
      "extension.install",
      "extension.update",
      "extension.remove",
      "extension.catalog.refresh",
      "extension.source.add",
      "extension.source.remove",
    ],
  },
  {
    group: "transit",
    actions: [
      "transit.catalog.propose",
      "transit.catalog.validate",
      "transit.catalog.activate",
      "transit.catalog.cancel",
      "transit.credential.update",
      "transit.lock.bump",
      "transit.source.add",
      "transit.source.enable",
      "transit.source.disable",
      "transit.source.remove",
    ],
  },
  { group: "jobs", actions: ["job.cancel", "data_manager.job.cancel"] },
  {
    group: "system",
    actions: [
      "system.update.check",
      "system.update",
      "system.diagnostics.collect",
      "dawarich.provision",
      "dawarich.oidc_secret.rotate",
    ],
  },
  {
    group: "users",
    actions: [
      "user.create",
      "user.invitation.send",
      "user.email_verification.send",
      "user.email.verify",
      "user.delete",
      "user.role.change",
      "user.ban",
      "user.unban",
      "user.impersonate",
      "user.password.set",
      "user.password_reset.send",
      "user.password.reset",
      "user.session.revoke",
      "user.session.revoke_all",
    ],
  },
  {
    group: "timeline",
    actions: ["timeline.connect", "timeline.switch", "timeline.test", "timeline.disconnect"],
  },
];

export const KNOWN_AUDIT_ACTIONS: ReadonlySet<string> = new Set(
  AUDIT_ACTION_GROUPS.flatMap((group) => group.actions),
);

export const AUDIT_TARGET_TYPES: readonly AuditTargetType[] = RECORDED_TARGET_TYPES;

export const DESTRUCTIVE_AUDIT_ACTIONS: ReadonlySet<string> = new Set<AuditAction>([
  "integration.credential.delete",
  "service.stop",
  "service.credential.delete",
  "backup.delete",
  "backup.prune",
  "ambient_places.discard",
  "extension.remove",
  "extension.source.remove",
  "transit.source.remove",
  "job.cancel",
  "data_manager.job.cancel",
  "cache.clear",
  "user.delete",
  "user.ban",
  "user.session.revoke",
  "user.session.revoke_all",
]);
