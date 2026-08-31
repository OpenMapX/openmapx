import { envString } from "@openmapx/core/server-env";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { appLogger } from "../services/app-logger";
import { invalidateDataUsePolicy, refreshDataUsePolicy } from "../services/data-use-policy";
import { writeAuditLog } from "../utils/audit-log";
import { loadEmailConfig, sendViaEmailLabs, sendViaLettermint, sendViaSmtp } from "../utils/email";
import { emailTestLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";

interface SettingDef {
  group: string;
  key: string;
  label: string;
  description?: string;
  type: "string" | "number" | "boolean" | "object" | "select";
  options?: string[];
  secret?: boolean;
  env?: string;
  default: unknown;
  /**
   * Optional subgroup identifier. Settings sharing a subgroup render under a
   * common subheader on the client. Used in the Email panel to split the
   * SMTP / EmailLabs / Lettermint alternatives clearly.
   */
  subgroup?: string;
  /**
   * Show this setting only when another setting in the same group has a
   * matching value. Evaluated client-side against the current local form
   * state — lets a panel hide fields that don't apply to the current choice.
   */
  showWhen?: { key: string; equals: unknown | unknown[] };
}

const SETTING_DEFS: SettingDef[] = [
  // General
  {
    group: "general",
    key: "instanceName",
    label: "Instance Name",
    description: "Display name shown in the admin UI and page titles.",
    type: "string",
    env: "INSTANCE_NAME",
    default: "OpenMapX",
  },
  {
    group: "general",
    key: "instanceUrl",
    label: "Instance URL",
    description: "Public URL of this OpenMapX instance (used in emails and links).",
    type: "string",
    env: "PUBLIC_URL",
    default: "",
  },
  {
    group: "general",
    key: "defaultLocale",
    label: "Default Locale",
    type: "select",
    options: ["en", "de", "fr", "es", "it", "nl", "pt", "pl", "ja", "zh"],
    env: "DEFAULT_LOCALE",
    default: "en",
  },
  {
    group: "general",
    key: "mapCenter",
    label: "Default Map Center",
    description: "Default latitude, longitude and zoom for the map on first load.",
    type: "object",
    default: { lat: 20, lng: 0, zoom: 2 },
  },
  // Authentication
  {
    group: "auth",
    key: "emailVerificationRequired",
    label: "Require Email Verification",
    description: "New users must verify their email before accessing the app.",
    type: "boolean",
    env: "AUTH_EMAIL_VERIFICATION",
    default: false,
  },
  {
    group: "auth",
    key: "sessionDurationHours",
    label: "Session Duration (hours)",
    description: "How long a session stays valid after the last activity.",
    type: "number",
    default: 168,
  },
  {
    group: "auth",
    key: "twoFaEnabled",
    label: "Enable Two-Factor Authentication",
    description: "Allow users to enroll in TOTP-based 2FA.",
    type: "boolean",
    default: false,
  },
  {
    group: "auth",
    key: "passwordMinLength",
    label: "Minimum Password Length",
    type: "number",
    default: 8,
  },
  // Email — shared field used by every provider.
  {
    group: "email",
    subgroup: "common",
    key: "smtpFromAddress",
    label: "From Address",
    description: "Used as the From header by every provider. e.g. noreply@example.com",
    type: "string",
    env: "EMAIL_FROM",
    default: "",
  },
  // EmailLabs (Polish EU provider, 9k emails/mo free) — priority 1.
  // Send picks EmailLabs when all three fields are set, otherwise falls
  // through to Lettermint, then SMTP. See apps/api/src/utils/email.ts.
  {
    group: "email",
    subgroup: "emaillabs",
    key: "emailLabsAppKey",
    label: "App Key",
    type: "string",
    secret: true,
    env: "EMAILLABS_APP_KEY",
    default: "",
  },
  {
    group: "email",
    subgroup: "emaillabs",
    key: "emailLabsSecretKey",
    label: "Secret Key",
    type: "string",
    secret: true,
    env: "EMAILLABS_SECRET_KEY",
    default: "",
  },
  {
    group: "email",
    subgroup: "emaillabs",
    key: "emailLabsSmtpAccount",
    label: "SMTP Account",
    type: "string",
    env: "EMAILLABS_SMTP_ACCOUNT",
    default: "",
  },
  // Lettermint (Dutch EU provider, 300 emails/mo free) — priority 2.
  {
    group: "email",
    subgroup: "lettermint",
    key: "lettermintApiToken",
    label: "API Token",
    type: "string",
    secret: true,
    env: "LETTERMINT_API_TOKEN",
    default: "",
  },
  // SMTP — universal fallback (priority 3).
  {
    group: "email",
    subgroup: "smtp",
    key: "smtpHost",
    label: "Host",
    type: "string",
    env: "SMTP_HOST",
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtpPort",
    label: "Port",
    type: "number",
    env: "SMTP_PORT",
    default: 587,
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtpUser",
    label: "Username",
    type: "string",
    env: "SMTP_USER",
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtpPassword",
    label: "Password",
    type: "string",
    secret: true,
    env: "SMTP_PASS",
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtpTls",
    label: "Use TLS / STARTTLS",
    type: "boolean",
    env: "SMTP_SECURE",
    default: true,
  },
  // Map
  {
    group: "map",
    key: "maptilerApiKey",
    label: "MapTiler API Key",
    description: "MapTiler Cloud API key for the built-in MapTiler tile and style proxy.",
    type: "string",
    secret: true,
    env: "MAPTILER_KEY",
    default: "",
  },
  // Data-Use Policy
  {
    group: "policy",
    key: "allowNonCommercial",
    label: "Allow non-commercial-only sources",
    description:
      "When on (default), data sources whose licence forbids commercial use (e.g. Open-Meteo, RainViewer) are included. Turn off for a commercial deployment unless you hold commercial terms for them.",
    type: "boolean",
    env: "OPENMAPX_ALLOW_NONCOMMERCIAL",
    default: true,
  },
  {
    group: "policy",
    key: "allowGreyArea",
    label: "Allow grey-area / undocumented-terms sources",
    description:
      "When on (default), data sources with unclear or undocumented usage terms (e.g. unofficial or scraped APIs) are included — most are public APIs whose terms are merely undocumented. Turn off to exclude them (e.g. DB/HAFAS and the regional-transit registry).",
    type: "boolean",
    env: "OPENMAPX_ALLOW_GREY_AREA",
    default: true,
  },
  // Legal pages — facts published on /privacy that vary by hosting setup.
  // Resolved env > database > default like every other setting here, then
  // read by the public /legal-config endpoint that the privacy page fetches.
  {
    group: "legal",
    key: "legalHostingProvider",
    label: "Hosting Provider",
    description:
      "Company that hosts this instance's servers. Named in the privacy policy's hosting section as the data processor (Art. 28 GDPR). Leave blank to omit that sentence.",
    type: "string",
    env: "LEGAL_HOSTING_PROVIDER",
    default: "",
  },
  {
    group: "legal",
    key: "legalHostingLocations",
    label: "Hosting Data-Center Locations",
    description:
      'Where the hosting data centers are located (e.g. "Germany, Finland"). Appended to the hosting sentence on /privacy. Leave blank to omit.',
    type: "string",
    env: "LEGAL_HOSTING_LOCATIONS",
    default: "",
  },
  {
    group: "legal",
    key: "legalSupervisoryAuthority",
    label: "Data-Protection Supervisory Authority",
    description:
      "Name of the competent data-protection supervisory authority, shown in the privacy policy's GDPR-rights section. Leave blank to omit that sentence.",
    type: "string",
    env: "LEGAL_SUPERVISORY_AUTHORITY",
    default: "",
  },
  {
    group: "legal",
    key: "legalSupervisoryAuthorityUrl",
    label: "Supervisory Authority URL",
    description:
      "Link to the supervisory authority named above. Rendered next to it on /privacy. Leave blank to show just the name.",
    type: "string",
    env: "LEGAL_SUPERVISORY_AUTHORITY_URL",
    default: "",
  },
  {
    group: "legal",
    key: "legalServerLogRetentionDays",
    label: "Server-Log Retention (days)",
    description:
      "How long server access logs are kept before automatic deletion. Stated verbatim in the privacy policy. Must be a positive whole number; defaults to 30.",
    type: "number",
    env: "LEGAL_SERVER_LOG_RETENTION_DAYS",
    default: 30,
  },
];

type SettingSource = "default" | "database" | "env";

interface ResolvedSetting {
  group: string;
  subgroup?: string;
  key: string;
  label: string;
  description?: string;
  type: string;
  options?: string[];
  secret: boolean;
  value: unknown;
  source: SettingSource;
  envVar?: string;
  envOverride: boolean;
  showWhen?: { key: string; equals: unknown | unknown[] };
}

interface SettingsGroup {
  id: string;
  label: string;
  settings: ResolvedSetting[];
}

const GROUP_LABELS: Record<string, string> = {
  general: "General",
  auth: "Authentication",
  email: "Email",
  map: "Map",
  policy: "Data-Use Policy",
  legal: "Legal",
};

function parseEnvValue(raw: string, type: SettingDef["type"]): unknown {
  if (type === "boolean") return raw === "true" || raw === "1";
  if (type === "number") return Number(raw);
  return raw;
}

function matchesDeclaredType(def: SettingDef, value: unknown): boolean {
  switch (def.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "select":
      return typeof value === "string" && (def.options?.includes(value) ?? true);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export async function resolveSettings(): Promise<SettingsGroup[]> {
  const dbRows = await db.select().from(systemSettings);
  const dbMap = Object.fromEntries(dbRows.map((r) => [r.key, r.value]));

  const grouped: Record<string, ResolvedSetting[]> = {};

  for (const def of SETTING_DEFS) {
    const envVal = def.env ? process.env[def.env] : undefined;
    const dbVal = dbMap[def.key];

    let value: unknown;
    let source: SettingSource;

    if (envVal !== undefined && envVal !== "") {
      value = parseEnvValue(envVal, def.type);
      source = "env";
    } else if (dbVal !== undefined) {
      value = dbVal;
      source = "database";
    } else {
      value = def.default;
      source = "default";
    }

    // Never send a raw secret to the client, whatever its source. "***" is a
    // "configured" sentinel so the UI can show the field as set + locked
    // without exposing the value (the real value stays in env / the DB).
    if (def.secret && value !== "") {
      value = "***";
    }

    if (!grouped[def.group]) grouped[def.group] = [];
    grouped[def.group].push({
      group: def.group,
      subgroup: def.subgroup,
      key: def.key,
      label: def.label,
      description: def.description,
      type: def.type,
      options: def.options,
      secret: def.secret ?? false,
      value,
      source,
      envVar: def.env,
      envOverride: source === "env",
      showWhen: def.showWhen,
    });
  }

  const groups = Object.entries(GROUP_LABELS).map(([id, label]) => ({
    id,
    label,
    settings: grouped[id] ?? [],
  }));

  return groups;
}

export async function adminSettingsRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  app.get("/admin/settings", async () => {
    const groups = await resolveSettings();
    return { groups };
  });

  app.patch<{ Body: Record<string, unknown> }>("/admin/settings", async (request, reply) => {
    const adminSession = getAdminSession(request);

    const updates = request.body;
    if (!updates || typeof updates !== "object") {
      return reply.status(400).send({ error: "Body must be an object of { key: value } pairs" });
    }

    const allowedKeys = new Set(
      SETTING_DEFS.filter((d) => {
        const envVal = d.env ? process.env[d.env] : undefined;
        return !(envVal !== undefined && envVal !== "");
      }).map((d) => d.key),
    );

    const defsByKey = new Map(SETTING_DEFS.map((d) => [d.key, d]));
    const toWrite: Array<{ key: string; value: unknown }> = [];
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!allowedKeys.has(key)) continue;
      const def = defsByKey.get(key);
      if (!def || !matchesDeclaredType(def, value)) {
        rejected.push(key);
        continue;
      }
      toWrite.push({ key, value });
    }
    if (rejected.length > 0) {
      return reply.status(400).send({
        error: `Value type does not match the setting definition: ${rejected.join(", ")}`,
      });
    }

    for (const { key, value } of toWrite) {
      await db
        .insert(systemSettings)
        .values({
          key,
          value: value as never,
          updatedBy: adminSession.user.id,
        })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            value: value as never,
            updatedAt: new Date(),
            updatedBy: adminSession.user.id,
          },
        });
    }

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "settings",
      targetId: "system",
      action: "settings.update",
      details: { keys: toWrite.map((t) => t.key) },
      request,
    });

    // Policy toggles take effect immediately rather than after the cache TTL.
    // Invalidate alone only marks the cache stale — the synchronous gated-set
    // getters behind the response filter keep serving the last-good sets until
    // a refresh lands, so await one here: by the time this response returns,
    // the new policy is live on every request path.
    invalidateDataUsePolicy();
    await refreshDataUsePolicy();

    const groups = await resolveSettings();
    return { ok: true, groups };
  });

  app.post(
    "/admin/settings/test-email",
    { preHandler: [emailTestLimit.preHandler()] },
    async (request, reply) => {
      const adminSession = getAdminSession(request);

      const config = await loadEmailConfig();

      // Validate the active provider has the inputs it needs before
      // attempting to send. Errors here become 400s so the operator gets
      // an actionable message in the admin UI.
      if (config.provider === "smtp" && !config.smtp.host) {
        return reply.status(400).send({ error: "SMTP host is not configured" });
      }
      if (!config.from) {
        return reply.status(400).send({ error: "From address is not configured" });
      }

      const recipientEmail = adminSession.user.email;
      if (!recipientEmail) {
        return reply.status(400).send({ error: "Your account has no email address" });
      }

      const rows = await db.select().from(systemSettings);
      const dbMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const instanceName = envString("INSTANCE_NAME", (dbMap.instanceName ?? "OpenMapX") as string);

      const subject = `[${instanceName}] Test Email`;
      const sentAt = new Date().toISOString();
      const text = `This is a test email from ${instanceName}.\n\nIf you received this, your ${config.provider} settings are configured correctly.\n\nSent at: ${sentAt}`;
      const html = `<p>This is a test email from <strong>${instanceName}</strong>.</p><p>If you received this, your ${config.provider} settings are configured correctly.</p><p><small>Sent at: ${sentAt}</small></p>`;

      try {
        switch (config.provider) {
          case "emaillabs":
            await sendViaEmailLabs({ to: recipientEmail, subject, text, html }, config);
            break;
          case "lettermint":
            await sendViaLettermint({ to: recipientEmail, subject, text, html }, config);
            break;
          case "smtp":
            await sendViaSmtp({ to: recipientEmail, subject, text, html }, config);
            break;
        }

        await writeAuditLog({
          actorId: adminSession.user.id,
          targetType: "settings",
          targetId: "email",
          action: "settings.test_email",
          details: { recipient: recipientEmail, provider: config.provider, status: "sent" },
          request,
        });

        return {
          ok: true,
          message: `Test email sent to ${recipientEmail} via ${config.provider}`,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        await writeAuditLog({
          actorId: adminSession.user.id,
          targetType: "settings",
          targetId: "email",
          action: "settings.test_email",
          details: {
            recipient: recipientEmail,
            provider: config.provider,
            status: "failed",
            error: errorMessage,
          },
          request,
        });

        return reply.status(500).send({
          error: "Failed to send test email",
          details: errorMessage,
        });
      }
    },
  );

  app.post("/admin/settings/export", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const groups = await resolveSettings();
    const exported: Record<string, unknown> = {};

    for (const group of groups) {
      for (const s of group.settings) {
        if (!s.envOverride && !s.secret) {
          exported[s.key] = s.value;
        }
      }
    }

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "settings",
      targetId: "system",
      action: "settings.export",
      request,
    });

    return { settings: exported, exportedAt: new Date().toISOString() };
  });

  app.post<{ Body: { settings: Record<string, unknown> } }>(
    "/admin/settings/import",
    async (request, reply) => {
      const adminSession = getAdminSession(request);

      const { settings } = request.body ?? {};
      if (!settings || typeof settings !== "object") {
        return reply.status(400).send({ error: "Body must have a 'settings' object" });
      }

      const allowedKeys = new Set(SETTING_DEFS.filter((d) => !d.secret).map((d) => d.key));
      const defsByKey = new Map(SETTING_DEFS.map((d) => [d.key, d]));
      let imported = 0;
      const skipped: string[] = [];

      for (const [key, value] of Object.entries(settings)) {
        if (!allowedKeys.has(key)) continue;
        const def = defsByKey.get(key);
        if (!def || !matchesDeclaredType(def, value)) {
          skipped.push(key);
          continue;
        }
        await db
          .insert(systemSettings)
          .values({ key, value: value as never, updatedBy: adminSession.user.id })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: {
              value: value as never,
              updatedAt: new Date(),
              updatedBy: adminSession.user.id,
            },
          });
        imported++;
      }

      await writeAuditLog({
        actorId: adminSession.user.id,
        targetType: "settings",
        targetId: "system",
        action: "settings.import",
        details: { imported, skipped },
        request,
      });

      return { ok: true, imported, skipped };
    },
  );

  app.get("/admin/logs", async (request) => {
    const {
      level,
      source,
      search,
      since,
      limit = "100",
      offset = "0",
    } = request.query as {
      level?: string;
      source?: string;
      search?: string;
      since?: string;
      limit?: string;
      offset?: string;
    };

    const result = appLogger.getEntries({
      level,
      source,
      search,
      since: since ? Number(since) : undefined,
      limit: Math.min(Number(limit), 500),
      offset: Number(offset),
    });

    return {
      ...result,
      sources: appLogger.getSources(),
    };
  });
}
