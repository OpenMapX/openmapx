import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { appLogger } from "../services/app-logger";
import { writeAuditLog } from "../utils/audit-log";
import { loadEmailConfig, sendViaEmailLabs, sendViaLettermint, sendViaSmtp } from "../utils/email";
import { emailTestLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";

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
  // Email / SMTP
  {
    group: "email",
    key: "smtpHost",
    label: "SMTP Host",
    type: "string",
    env: "SMTP_HOST",
    default: "",
  },
  {
    group: "email",
    key: "smtpPort",
    label: "SMTP Port",
    type: "number",
    env: "SMTP_PORT",
    default: 587,
  },
  {
    group: "email",
    key: "smtpUser",
    label: "SMTP Username",
    type: "string",
    env: "SMTP_USER",
    default: "",
  },
  {
    group: "email",
    key: "smtpPassword",
    label: "SMTP Password",
    type: "string",
    secret: true,
    env: "SMTP_PASS",
    default: "",
  },
  {
    group: "email",
    key: "smtpTls",
    label: "Use TLS / STARTTLS",
    type: "boolean",
    env: "SMTP_SECURE",
    default: true,
  },
  {
    group: "email",
    key: "smtpFromAddress",
    label: "From Address",
    description: "e.g. noreply@example.com",
    type: "string",
    env: "EMAIL_FROM",
    default: "",
  },
  // EmailLabs (Polish EU provider, 9k emails/mo free) — priority 1.
  // Send picks EmailLabs when all three fields are set, otherwise falls
  // through to Lettermint, then SMTP. See apps/api/src/utils/email.ts.
  {
    group: "email",
    key: "emailLabsAppKey",
    label: "EmailLabs App Key",
    description: "Set all three EmailLabs fields to use it instead of SMTP.",
    type: "string",
    secret: true,
    env: "EMAILLABS_APP_KEY",
    default: "",
  },
  {
    group: "email",
    key: "emailLabsSecretKey",
    label: "EmailLabs Secret Key",
    type: "string",
    secret: true,
    env: "EMAILLABS_SECRET_KEY",
    default: "",
  },
  {
    group: "email",
    key: "emailLabsSmtpAccount",
    label: "EmailLabs SMTP Account",
    type: "string",
    env: "EMAILLABS_SMTP_ACCOUNT",
    default: "",
  },
  // Lettermint (Dutch EU provider, 300 emails/mo free) — priority 2.
  {
    group: "email",
    key: "lettermintApiToken",
    label: "Lettermint API Token",
    description: "Set this to use Lettermint when EmailLabs is unconfigured.",
    type: "string",
    secret: true,
    env: "LETTERMINT_API_TOKEN",
    default: "",
  },
  // Map
  {
    group: "map",
    key: "styleProvider",
    label: "Style Provider",
    description: "Where to load the base map style from.",
    type: "select",
    options: ["maptiler", "self-hosted", "custom"],
    env: "MAP_STYLE_PROVIDER",
    default: "maptiler",
  },
  {
    group: "map",
    key: "maptilerApiKey",
    label: "MapTiler API Key",
    type: "string",
    secret: true,
    env: "NEXT_PUBLIC_MAPTILER_KEY",
    default: "",
  },
  {
    group: "map",
    key: "customStyleUrl",
    label: "Custom Style URL",
    description: "Used when style provider is set to 'custom'.",
    type: "string",
    env: "CUSTOM_STYLE_URL",
    default: "",
  },
];

type SettingSource = "default" | "database" | "env";

interface ResolvedSetting {
  group: string;
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
}

interface SettingsGroup {
  id: string;
  label: string;
  settings: ResolvedSetting[];
}

const GROUP_LABELS: Record<string, string> = {
  general: "General",
  auth: "Authentication",
  email: "Email / SMTP",
  map: "Map",
};

function parseEnvValue(raw: string, type: SettingDef["type"]): unknown {
  if (type === "boolean") return raw === "true" || raw === "1";
  if (type === "number") return Number(raw);
  return raw;
}

async function resolveSettings(): Promise<SettingsGroup[]> {
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

    if (def.secret && source !== "env" && value !== "") {
      value = source === "database" ? "***" : "";
    }

    if (!grouped[def.group]) grouped[def.group] = [];
    grouped[def.group].push({
      group: def.group,
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
  app.addHook("preHandler", async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return reply;
    request.adminSession = session;
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

    const toWrite: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!allowedKeys.has(key)) continue;
      toWrite.push({ key, value });
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
      const instanceName = (process.env.INSTANCE_NAME ??
        dbMap.instanceName ??
        "OpenMapX") as string;

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
      let imported = 0;

      for (const [key, value] of Object.entries(settings)) {
        if (!allowedKeys.has(key)) continue;
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
        details: { imported },
        request,
      });

      return { ok: true, imported };
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
