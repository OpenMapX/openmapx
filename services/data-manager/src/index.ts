import Fastify from "fastify";
import { registerApi } from "./api.js";
import { registerAuth, resolveAuthToken } from "./auth.js";

const app = Fastify({ logger: true });
registerAuth(app, resolveAuthToken(app));
registerApi(app);

const port = Number(process.env.PORT ?? 4000);
// Bind to loopback by default. Docker-compose overrides this to 0.0.0.0 so
// app-api can reach us over the service network; exposing on 0.0.0.0 without
// the token guard would be an unauthenticated-mutation risk on multi-tenant
// hosts.
const host = process.env.HOST ?? "127.0.0.1";

app
  .listen({ port, host })
  .then((addr) => app.log.info(`data-manager listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
