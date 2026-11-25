import type { FastifyInstance } from "fastify";
import { appLogger } from "../services/app-logger";
import { invalidateDataUsePolicy, refreshDataUsePolicy } from "../services/data-use-policy";
import { assertSecretsConfigured } from "../services/secrets";
import {
  isSecretSetting,
  isSetInEnvironment,
  matchesDeclaredType,
  SETTING_DEFS,
  SecretSettingUnreadableError,
  saveSystemSettings,
  settingsView,
} from "../services/settings";
import { writeAuditLog } from "../utils/audit-log";
import { loadEmailConfig, sendViaEmailLabs, sendViaLettermint, sendViaSmtp } from "../utils/email";
import { invalidateMapSettings } from "../utils/map-settings";
import { emailTestLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";

export async function adminSettingsRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");

  app.addHook("onRequest", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  registerServiceAdminRoute(app, "getAdminSettings", async () => {
    const groups = await settingsView();
    return { groups };
  });

  registerServiceAdminRoute(app, "updateAdminSettings", async (request, reply) => {
    const adminSession = getAdminSession(request);
    const updates = request.body;

    // The environment's value wins, and a setting only it sets is never stored.
    const allowedKeys = new Set(
      SETTING_DEFS.filter((d) => !d.envOnly && !isSetInEnvironment(d)).map((d) => d.key),
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
    // Secret settings are stored encrypted; without a usable key none is saved.
    if (toWrite.some(({ key, value }) => isSecretSetting(key) && value !== "")) {
      try {
        assertSecretsConfigured();
      } catch (error) {
        return reply.status(400).send({ error: (error as Error).message });
      }
    }

    await saveSystemSettings(toWrite, adminSession.user.id);

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: "system",
      action: "setting.update",
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

    const groups = await settingsView();
    return {
      ok: true,
      groups,
      ...(toWrite.some((v) => defsByKey.get(v.key)?.group === "auth")
        ? { authPolicyApplication: "pending" as const }
        : {}),
    };
  });

  registerServiceAdminRoute(
    app,
    "sendAdminTestEmail",
    async (request, reply) => {
      const adminSession = getAdminSession(request);

      let config: Awaited<ReturnType<typeof loadEmailConfig>>;
      try {
        config = await loadEmailConfig();
      } catch (error) {
        // A stored credential the current secrets key cannot open: say so.
        if (error instanceof SecretSettingUnreadableError) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }

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

      const subject = "[OpenMapX] Test Email";
      const sentAt = new Date().toISOString();
      const text = `This is a test email from OpenMapX.\n\nIf you received this, your ${config.provider} settings are configured correctly.\n\nSent at: ${sentAt}`;
      const html = `<p>This is a test email from <strong>OpenMapX</strong>.</p><p>If you received this, your ${config.provider} settings are configured correctly.</p><p><small>Sent at: ${sentAt}</small></p>`;

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
          targetId: "email",
          action: "setting.test_email.send",
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
          targetId: "email",
          action: "setting.test_email.send",
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
    { preHandler: [emailTestLimit.preHandler()] },
  );

  registerServiceAdminRoute(app, "listAdminLogs", async (request) => {
    const { level, source, search, since, limit = "100", offset = "0" } = request.query;
    const result = appLogger.getEntries({
      level,
      source,
      search,
      since: since ? Number(since) : undefined,
      limit: Math.min(Number(limit), 500),
      offset: Number(offset),
    });
    return { ...result, sources: appLogger.getSources() };
  });
}
