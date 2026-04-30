import type { Command } from "commander";
import { dockerCompose } from "../lib/docker";
import { log, table } from "../lib/output";

interface PsLine {
  Service?: string;
  Name?: string;
  State?: string;
  Health?: string;
}

/**
 * Application-level deep probes per service, restored from the old
 * `manage.sh check` runbook. The renderer's docker healthcheck already covers
 * the "is the process up?" case via `docker compose ps`; this map adds the
 * "is it returning real responses?" check that catches wedged-but-running
 * states (Pelias indexer not finished, MOTIS missing config feeds, etc.).
 *
 * `path` is appended to `http://<service-id>:<port>` and probed from an
 * ephemeral curl container on the openmapx network — no dependency on what
 * tooling each service image happens to ship. `expect` is a substring grep on
 * the response body; omit to require any 2xx.
 */
const DEEP_PROBES: Record<string, { port: number; path: string; expect?: string } | null> = {
  valhalla: { port: 8002, path: "/status", expect: "tileset_last_modified" },
  osrm: { port: 5000, path: "/nearest/v1/driving/13.405,52.52", expect: "waypoints" },
  motis: { port: 8080, path: "/api/v1/geocode?text=test", expect: "name" },
  otp: { port: 8080, path: "/otp/routers" },
  nominatim: { port: 8080, path: "/status" },
  photon: { port: 2322, path: "/api?q=test", expect: "features" },
  overpass: {
    port: 80,
    path: "/api/interpreter?data=%5Bout%3Ajson%5D%3Bnode(1)%3Bout%3B",
    expect: "elements",
  },
  tileserver: { port: 8080, path: "/health" },
  pelias: { port: 4000, path: "/v1/place?ids=whosonfirst:locality:101748479" },
  "app-api": { port: 3001, path: "/health" },
  martin: { port: 3000, path: "/health" },
  // Services whose engine-level healthcheck is the most useful probe — leave to docker.
  postgis: null,
  redis: null,
  elasticsearch: null,
  traefik: null,
  "app-web": null,
  "well-known": null,
  "data-manager": { port: 4000, path: "/status", expect: "ok" },
  "motis-feed-proxy": { port: 80, path: "/healthz" },
  "pelias-pip": { port: 4200, path: "/" },
  "pelias-placeholder": { port: 4100, path: "/parser/findbyid?ids=1" },
};

interface ProbeResult {
  status: "ok" | "fail" | "skipped";
  detail: string;
}

async function runDeepProbe(serviceId: string, network: string): Promise<ProbeResult> {
  const probe = DEEP_PROBES[serviceId];
  if (probe === null) return { status: "skipped", detail: "no app-level probe" };
  if (probe === undefined) return { status: "skipped", detail: "unknown service" };

  const url = `http://${serviceId}:${probe.port}${probe.path}`;
  const result = await dockerCompose([
    "run",
    "--rm",
    "--no-deps",
    "--network",
    network,
    "--entrypoint",
    "wget",
    "alpine/wget:1.27.0",
    "-q",
    "-O-",
    "-T",
    "5",
    url,
  ]);

  if (result.exitCode !== 0) {
    const stderr =
      result.stderr
        .split("\n")
        .filter((line) => line.trim())
        .slice(-1)[0] ?? "";
    return { status: "fail", detail: stderr.trim() || `exit ${result.exitCode}` };
  }
  if (probe.expect && !result.stdout.toLowerCase().includes(probe.expect.toLowerCase())) {
    return { status: "fail", detail: `response missing "${probe.expect}"` };
  }
  return { status: "ok", detail: "" };
}

async function detectComposeNetwork(): Promise<string> {
  // docker-compose names networks `<project>_<name>`. Our compose declares one
  // network called `openmapx`, so the project prefix is the only variable.
  const result = await dockerCompose(["config", "--services"]);
  if (result.exitCode === 0) {
    const inspect = await dockerCompose(["ls", "--format", "json"]);
    if (inspect.exitCode === 0 && inspect.stdout.trim()) {
      try {
        const rows = JSON.parse(inspect.stdout) as Array<{ Name?: string }>;
        const project = rows.find((r) => r.Name)?.Name;
        if (project) return `${project}_openmapx`;
      } catch {
        // fall through
      }
    }
  }
  return "docker_openmapx";
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run health checks against running services")
    .option("--no-probe", "Skip in-network HTTP deep probes (faster; engine-health only)")
    .action(async (options: { probe: boolean }) => {
      const result = await dockerCompose(["ps", "--format", "json"]);
      if (result.exitCode !== 0) {
        log.err(result.stderr || "docker compose ps failed");
        process.exit(result.exitCode);
      }

      const rows: PsLine[] = [];
      const text = result.stdout.trim();
      if (text.length > 0) {
        try {
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

      const network = options.probe ? await detectComposeNetwork() : "";

      type Report = {
        service: string;
        state: string;
        health: string;
        status: string;
        probe: string;
      };
      const report: Report[] = [];

      for (const row of rows) {
        const service = row.Service ?? "(unknown)";
        const state = (row.State ?? "unknown").toLowerCase();
        const health = (row.Health ?? "").toLowerCase();

        let status = "ok";
        if (state !== "running") status = "not-running";
        else if (health === "unhealthy") status = "unhealthy";
        else if (health === "starting") status = "starting";

        let probeDetail = "—";
        if (options.probe && state === "running" && health !== "starting") {
          const r = await runDeepProbe(service, network);
          probeDetail = r.status === "ok" ? "ok" : `${r.status}: ${r.detail}`;
          if (r.status === "fail" && status === "ok") status = "probe-fail";
        }

        report.push({
          service,
          state,
          health: health || "—",
          status,
          probe: probeDetail,
        });
      }

      console.log(
        table(
          [
            { key: "service", header: "Service" },
            { key: "state", header: "State" },
            { key: "health", header: "Health" },
            { key: "probe", header: "Probe" },
            { key: "status", header: "Status" },
          ],
          report,
        ),
      );

      const failures = report.filter(
        (row) =>
          row.status === "unhealthy" || row.status === "probe-fail" || row.state === "restarting",
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
          `${failures.length} service${failures.length === 1 ? "" : "s"} unhealthy, restarting, or failing app-level probe.`,
        );
        process.exit(1);
      }

      log.ok("All running services look healthy.");
    });
}
