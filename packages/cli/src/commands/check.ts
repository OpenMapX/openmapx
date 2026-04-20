import type { Command } from "commander";
import { dockerCompose } from "../lib/docker";
import { log, table } from "../lib/output";

interface PsLine {
  Service?: string;
  Name?: string;
  State?: string;
  Health?: string;
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run health checks against running services")
    .action(async () => {
      const result = await dockerCompose(["ps", "--format", "json"]);
      if (result.exitCode !== 0) {
        log.err(result.stderr || "docker compose ps failed");
        process.exit(result.exitCode);
      }

      const rows: PsLine[] = [];
      const text = result.stdout.trim();
      if (text.length > 0) {
        try {
          // Compose has emitted both NDJSON and JSON-array forms across versions.
          const parsed = JSON.parse(text) as unknown;
          if (Array.isArray(parsed)) {
            for (const row of parsed) {
              if (row && typeof row === "object") rows.push(row as PsLine);
            }
          } else if (parsed && typeof parsed === "object") {
            rows.push(parsed as PsLine);
          }
        } catch {
          for (const line of result.stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              rows.push(JSON.parse(trimmed) as PsLine);
            } catch {
              // Ignore malformed lines to keep check output resilient.
            }
          }
        }
      }

      if (rows.length === 0) {
        log.warn("No compose services found in the current project.");
        return;
      }

      const report = rows.map((row) => {
        const service = row.Service ?? "(unknown)";
        const container = row.Name ?? "—";
        const state = (row.State ?? "unknown").toLowerCase();
        const health = (row.Health ?? "").toLowerCase();

        let status = "ok";
        if (state !== "running") status = "not-running";
        else if (health === "unhealthy") status = "unhealthy";
        else if (health === "starting") status = "starting";

        return {
          service,
          container,
          state,
          health: health || "—",
          status,
        };
      });

      console.log(
        table(
          [
            { key: "service", header: "Service" },
            { key: "state", header: "State" },
            { key: "health", header: "Health" },
            { key: "status", header: "Status" },
          ],
          report.map((row) => ({
            service: row.service,
            state: row.state,
            health: row.health,
            status: row.status,
          })),
        ),
      );

      const failures = report.filter(
        (row) => row.status === "unhealthy" || row.state === "restarting",
      );
      const starting = report.filter((row) => row.status === "starting");
      const stopped = report.filter((row) => row.status === "not-running");

      if (stopped.length > 0) {
        log.warn(
          `${stopped.length} service${stopped.length === 1 ? "" : "s"} not running (skipped).`,
        );
      }
      if (starting.length > 0) {
        log.warn(`${starting.length} service${starting.length === 1 ? "" : "s"} still starting.`);
      }
      if (failures.length > 0) {
        log.err(
          `${failures.length} service${failures.length === 1 ? "" : "s"} unhealthy or restarting.`,
        );
        process.exit(1);
      }

      log.ok("All running services look healthy.");
    });
}
