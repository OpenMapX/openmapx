import { count, desc, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { adminAuditLog, session, user } from "../db/schema";
import { getAllIntegrations } from "../integration-host";
import { listActivityJobs } from "../services/activity-jobs";
import { isSelfHostedDeployment } from "../services/deployment-mode";
import {
  computeCredentialStatus,
  getIntegrationDisplayName,
} from "../services/integration-credential-status";
import { getCachedHealthStatus } from "../services/integration-health";
import { readServiceInventory } from "../services/service-inventory";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

export async function adminOverviewRoute(app: FastifyInstance): Promise<void> {
  registerIntegrationAdminRoute(app, "getAdminOverview", async () => {
    const selfHosted = isSelfHostedDeployment();
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      [userRow],
      [bannedRow],
      [activeSessionRow],
      integrations,
      recentAudit,
      activityJobs,
      inventory,
    ] = await Promise.all([
      db.select({ total: count() }).from(user),
      db.select({ total: count() }).from(user).where(eq(user.banned, true)),
      db.select({ total: count() }).from(session).where(gt(session.updatedAt, twentyFourHoursAgo)),
      Promise.resolve(getAllIntegrations()),
      db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(10),
      listActivityJobs({ limit: 10, offset: 0 }),
      selfHosted ? readServiceInventory() : Promise.resolve(null),
    ]);

    const totalUsers = userRow?.total ?? 0;
    const bannedUsers = bannedRow?.total ?? 0;
    const activeSessions24h = activeSessionRow?.total ?? 0;

    const totalIntegrations = integrations.length;
    const enabledIntegrations = integrations.filter((i) => i.enabled).length;
    const credentialStatuses = await Promise.all(
      integrations.filter((i) => i.enabled).map((i) => computeCredentialStatus(i)),
    );
    const unconfiguredIntegrations = credentialStatuses.filter(
      (statuses) => statuses.length > 0 && statuses.every((s) => s.source === "missing"),
    ).length;
    const unhealthyIntegrations = integrations.filter((i) => {
      if (!i.enabled || !i.manifest.healthCheck) return false;
      const cached = getCachedHealthStatus(i.id);
      return cached?.status === "down";
    }).length;

    const dockerServices =
      inventory?.services.map((s) => ({ service: s.id, state: s.status })) ?? [];
    const runningServices = inventory?.summary.running ?? 0;
    const stoppedServices = inventory?.summary.stopped ?? 0;
    const unknownServices = inventory?.summary.unknown ?? 0;
    const unhealthyServices = dockerServices.filter((s) => s.state === "restarting").length;

    // System health
    const unhealthyCount = unhealthyIntegrations + unhealthyServices;
    let overallHealth: "pass" | "degraded" | "down" = "pass";
    if (unhealthyCount > 0 || unknownServices > 0 || inventory?.acquisition.state === "unavailable")
      overallHealth = "degraded";
    if (
      (enabledIntegrations > 0 && unhealthyIntegrations > enabledIntegrations / 2) ||
      (selfHosted && runningServices > 0 && unhealthyServices > runningServices)
    ) {
      overallHealth = "down";
    }

    // Attention items
    const attention: Array<{
      type: string;
      severity: "warning" | "error" | "info";
      message: string;
      target?: string;
    }> = [];

    if (inventory?.acquisition.state === "unavailable")
      attention.push({
        type: "control_plane_unavailable",
        severity: "warning",
        message: "Service status is unavailable. Check the operations agent.",
        target: "/admin/services",
      });

    // Missing credentials — flag integrations where every declared secret is
    // unresolved in the actual configuration cascade.
    const enabledIntegrationList = integrations.filter((i) => i.enabled);
    for (let idx = 0; idx < enabledIntegrationList.length; idx++) {
      const i = enabledIntegrationList[idx];
      if (!i) continue;
      const statuses = credentialStatuses[idx] ?? [];
      if (statuses.length === 0) continue;
      if (statuses.every((s) => s.source === "missing")) {
        attention.push({
          type: "missing_credentials",
          severity: "warning",
          message: `${getIntegrationDisplayName(i)} has missing credentials`,
          target: i.id,
        });
      }
    }

    // Failing health checks
    for (const i of integrations) {
      if (!i.enabled || !i.manifest.healthCheck) continue;
      const cached = getCachedHealthStatus(i.id);
      if (cached?.status === "down") {
        attention.push({
          type: "health_check_failed",
          severity: "error",
          message: `${getIntegrationDisplayName(i)} health check failing: ${cached.error ?? "unknown"}`,
          target: i.id,
        });
      }
    }

    // Failed jobs among the most recent cross-system activity.
    for (const job of activityJobs.jobs) {
      if (job.status === "failed" || job.status === "interrupted") {
        attention.push({
          type: "job_failed",
          severity: "error",
          message: job.error
            ? `Job "${job.type}" failed: ${job.error}`
            : `Job "${job.type}" ${job.status === "interrupted" ? "was interrupted" : "failed"}`,
          target: job.id,
        });
      }
    }

    // `restarting` is the strongest failure signal exposed by
    // `docker compose ps --format json` without a separate health inspection.
    for (const svc of dockerServices) {
      if (svc.state === "restarting") {
        attention.push({
          type: "service_unhealthy",
          severity: "error",
          message: `Docker service "${svc.service}" is unhealthy`,
          target: svc.service,
        });
      }
    }

    return {
      systemHealth: {
        status: overallHealth,
        unhealthyCount,
      },
      users: {
        total: totalUsers,
        active24h: activeSessions24h,
        banned: bannedUsers,
      },
      integrations: {
        total: totalIntegrations,
        enabled: enabledIntegrations,
        unhealthy: unhealthyIntegrations,
        unconfigured: unconfiguredIntegrations,
      },
      services: selfHosted
        ? {
            running: runningServices,
            stopped: stoppedServices,
            unknown: unknownServices,
            unhealthy: unhealthyServices,
          }
        : null,
      attention,
      recentActivity: recentAudit,
      activeJobs: activityJobs.jobs,
    };
  });
}
