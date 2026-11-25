/**
 * The audit log's vocabulary. An action is `<area>[.<object>].<verb>`: an
 * imperative verb, a singular object and `snake_case` inside a segment. Each
 * action records one target type, or none. The API types its audit writers
 * against this registry and the database checks both columns against it.
 */

export const AUDIT_TARGET_TYPES = [
  "ambient_places",
  "auth_policy",
  "backup",
  "cache",
  "configuration",
  "configuration_migration",
  "credential_transfer",
  "data_manager_job",
  "data_operation",
  "extension",
  "integration",
  "job",
  "personal_timeline_connection",
  "platform",
  "provider",
  "release",
  "service",
  "setting",
  "system",
  "transit",
  "transit_credential",
  "transit_source",
  "user",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

const target = <T extends AuditTargetType | null>(targetType: T) => ({ targetType });

export const AUDIT_ACTIONS = {
  "ambient_places.build": target("ambient_places"),
  "ambient_places.discard": target("ambient_places"),
  "ambient_places.enabled.set": target("ambient_places"),
  "ambient_places.resume": target("ambient_places"),
  "ambient_places.rollback": target("ambient_places"),
  "auth.policy.apply": target("auth_policy"),
  "backup.create": target("backup"),
  "backup.delete": target("backup"),
  "backup.prune": target("backup"),
  "backup.restore": target("backup"),
  "cache.clear": target("cache"),
  "compose.render": target("configuration"),
  "configuration.migration.apply": target("configuration_migration"),
  "credential.export": target("credential_transfer"),
  "credential.import": target("configuration_migration"),
  "credential.import.preview": target("credential_transfer"),
  "data.operation.run": target("data_operation"),
  "data_manager.job.cancel": target("data_manager_job"),
  "dawarich.oidc_secret.rotate": target("service"),
  "dawarich.provision": target("service"),
  "extension.catalog.refresh": target(null),
  "extension.install": target("extension"),
  "extension.remove": target("extension"),
  "extension.source.add": target(null),
  "extension.source.remove": target(null),
  "extension.update": target("extension"),
  "integration.binding.remove": target("integration"),
  "integration.binding.set": target("integration"),
  "integration.config.update": target("integration"),
  "integration.credential.delete": target("integration"),
  "integration.credential.set": target("integration"),
  "integration.disable": target("integration"),
  "integration.enable": target("integration"),
  "integration.reload": target("integration"),
  "integration.reload_all": target("integration"),
  "job.cancel": target("job"),
  "platform.configuration.save": target("platform"),
  "provider.reset": target("provider"),
  "release.clear": target("release"),
  "service.apply": target("service"),
  "service.build": target("service"),
  "service.config.update": target("service"),
  "service.credential.delete": target("service"),
  "service.credential.set": target("service"),
  "service.health.check": target("service"),
  "service.image.pull": target("service"),
  "service.log.read": target("service"),
  "service.restart": target("service"),
  "service.selection.update": target("service"),
  "service.start": target("service"),
  "service.stop": target("service"),
  "service.update": target("service"),
  "setting.test_email.send": target("setting"),
  "setting.update": target("setting"),
  "standalone.install": target("integration"),
  "standalone.preview": target("integration"),
  "standalone.remove": target("integration"),
  "system.diagnostics.collect": target("system"),
  "system.update": target("system"),
  "system.update.check": target("system"),
  "timeline.connect": target("personal_timeline_connection"),
  "timeline.disconnect": target("personal_timeline_connection"),
  "timeline.switch": target("personal_timeline_connection"),
  "timeline.test": target("personal_timeline_connection"),
  "transit.catalog.activate": target("transit"),
  "transit.catalog.cancel": target("transit"),
  "transit.catalog.propose": target("transit"),
  "transit.catalog.validate": target("transit"),
  "transit.credential.update": target("transit_credential"),
  "transit.lock.bump": target("transit"),
  "transit.source.add": target("transit_source"),
  "transit.source.disable": target("transit_source"),
  "transit.source.enable": target("transit_source"),
  "transit.source.remove": target("transit_source"),
  "user.ban": target("user"),
  "user.create": target("user"),
  "user.delete": target("user"),
  "user.email.verify": target("user"),
  "user.email_verification.send": target("user"),
  "user.impersonate": target("user"),
  "user.invitation.send": target("user"),
  "user.password.reset": target("user"),
  "user.password.set": target("user"),
  "user.password_reset.send": target("user"),
  "user.role.change": target("user"),
  "user.session.revoke": target("user"),
  "user.session.revoke_all": target("user"),
  "user.unban": target("user"),
} as const satisfies Record<string, { targetType: AuditTargetType | null }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]];

/** The grammar every audit action follows. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

/** The action and the target type it records, for a row of the audit log. */
export function auditEntry<A extends AuditAction>(
  action: A,
): { action: A; targetType: (typeof AUDIT_ACTIONS)[A]["targetType"] } {
  return { action, targetType: AUDIT_ACTIONS[action].targetType };
}
