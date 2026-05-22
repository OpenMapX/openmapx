import { accessSync, constants } from "node:fs";
import Fastify from "fastify";
import { registerApi } from "./api.js";
import { registerAuth, resolveAuthToken } from "./auth.js";
import { awaitInflightSync, type CronHandles, setupCron } from "./cron.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import { StateStore } from "./state.js";

const app = Fastify({ logger: true });
registerAuth(app, resolveAuthToken(app));

const dataDir = process.env.DATA_DIR ?? "/data";
const repoRoot = process.env.OPENMAPX_ROOT_DIR ?? "";
const singleFlight = getSingleFlightController();

registerApi(app, { dataDir, repoRoot, singleFlight });

// E6.1c — Validate the age private-key file early so operators get a clear
// error at startup rather than a confusing "encrypted feed skipped" log
// halfway through a multi-hour GTFS run. Unset is fine: Transitous's
// fetch.py just skips encrypted entries when the env-var is absent.
const transitousFeedProxyKeyFile = process.env.TRANSITOUS_FEED_PROXY_KEY_FILE;
if (transitousFeedProxyKeyFile) {
  try {
    accessSync(transitousFeedProxyKeyFile, constants.R_OK);
  } catch (err) {
    app.log.error(
      { path: transitousFeedProxyKeyFile, err },
      "TRANSITOUS_FEED_PROXY_KEY_FILE points at an unreadable path; encrypted Transitous feeds will be skipped",
    );
  }
}

const port = Number(process.env.PORT ?? 4000);
// Bind to loopback by default. Docker-compose overrides this to 0.0.0.0 so
// app-api can reach us over the service network; exposing on 0.0.0.0 without
// the token guard would be an unauthenticated-mutation risk on multi-tenant
// hosts.
const host = process.env.HOST ?? "127.0.0.1";

// Track cron handles so the SIGTERM hook can stop them cleanly.
let cronHandles: CronHandles | null = null;

app
  .listen({ port, host })
  .then((addr) => {
    app.log.info(`data-manager listening on ${addr}`);

    // Wire cron _after_ listen so an early Fastify failure doesn't leave
    // dangling cron timers and so the in-process singleFlight controller is
    // fully ready before the first scheduled fire.
    const store = new StateStore(dataDir);
    const countries = (process.env.TRANSITOUS_COUNTRIES ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    cronHandles = setupCron({
      dataDir,
      repoRoot,
      countries,
      store,
      singleFlight,
      logger: app.log,
    });
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// Graceful shutdown — stop new cron fires, wait for any in-flight sync
// (bounded), then exit. Production-side this gives operators a clean SIGTERM
// path during `docker compose restart data-manager`; without it, a bounce
// during a multi-hour sync would truncate the catalog write.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "data-manager: shutdown requested");
  cronHandles?.stop();
  const result = await awaitInflightSync(singleFlight, 30_000);
  if (result === "timeout") {
    app.log.warn("data-manager: in-flight Transitous sync did not finish within 30s; forcing exit");
  }
  try {
    await app.close();
  } catch (err) {
    app.log.warn({ err }, "data-manager: fastify close threw");
  }
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}
