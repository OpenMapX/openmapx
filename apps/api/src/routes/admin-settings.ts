import { envString } from "@openmapx/core/server-env";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { appLogger } from "../services/app-logger";
import { invalidateDataUsePolicy, refreshDataUsePolicy } from "../services/data-use-policy";
import {
  matchesDeclaredType,
  parseEnvValue,
  resolveSettings,
  SETTING_DEFS,
} from "../services/settings";
import { writeAuditLog } from "../utils/audit-log";
import { loadEmailConfig, sendViaEmailLabs, sendViaLettermint, sendViaSmtp } from "../utils/email";
import { invalidateMapSettings } from "../utils/map-settings";
import { emailTestLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { resolveSettingPrecedence } from "../utils/settings-resolution";

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
        // Match GET's validated effective source: malformed env values do not lock the editor.
        return (
          resolveSettingPrecedence({
            envValue: d.env ? process.env[d.env] : undefined,
            databaseValue: undefined,
            defaultValue: d.default,
            parseEnv: (raw) => parseEnvValue(raw, d),
            validate: (candidate): candidate is unknown => matchesDeclaredType(d, candidate),
          }).source !== "env"
        );
      }).map((d) => d.key),
    );

    const defsByKey = new Map(SETTING_DEFS.map((d) => [d.key, d]));
    const toWrite: Array<{ key: string; value: unknown }> = [];
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!allowedKeys.has(key)) continue;
      const def = defsByKey.get(key);
      // A redacted secret is a preservation marker, never a replacement credential.
      if (def?.secret && value === "***") continue;
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

    await db.transaction(async (transaction) => {
      for (const { key, value } of toWrite) {
        await transaction
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
    });

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
    invalidateMapSettings();
    invalidateDataUsePolicy();
    await refreshDataUsePolicy();

    const groups = await resolveSettings();
    return {
      ok: true,
      groups,
      ...(toWrite.some((v) => defsByKey.get(v.key)?.group === "auth")
        ? { authPolicyApplication: "pending" as const }
        : {}),
    };
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

      const toWrite: Array<{ key: string; value: unknown }> = [];
      for (const [key, value] of Object.entries(settings)) {
        if (!allowedKeys.has(key)) continue;
        const def = defsByKey.get(key);
        if (!def || !matchesDeclaredType(def, value)) {
          if (def?.group === "auth")
            return reply.code(400).send({ error: "Invalid authentication policy draft" });
          skipped.push(key);
          continue;
        }
        toWrite.push({ key, value });
      }
      await db.transaction(async (transaction) => {
        for (const { key, value } of toWrite) {
          await transaction
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
        }
      });
      imported = toWrite.length;

      await writeAuditLog({
        actorId: adminSession.user.id,
        targetType: "settings",
        targetId: "system",
        action: "settings.import",
        details: { imported, skipped },
        request,
      });

      invalidateMapSettings();
      return {
        ok: true,
        imported,
        skipped,
        ...(toWrite.some((v) => defsByKey.get(v.key)?.group === "auth")
          ? { authPolicyApplication: "pending" as const }
          : {}),
      };
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
