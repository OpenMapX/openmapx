import Fastify from "fastify";
import { registerApi } from "./api.js";

const app = Fastify({ logger: true });
registerApi(app);

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

app
  .listen({ port, host })
  .then((addr) => app.log.info(`data-manager listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
