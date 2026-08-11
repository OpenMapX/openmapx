import type { IntegrationContext } from "@openmapx/integration-framework";

declare global {
  var __fixtureSetupOrder: string[] | undefined;
}

export function setup(ctx: IntegrationContext): void {
  // Record that setup ran, in a global so the test (which can't share a module
  // instance with an import()-loaded fixture) can observe the call order.
  globalThis.__fixtureSetupOrder ??= [];
  globalThis.__fixtureSetupOrder.push("alpha");

  ctx.registerRoute("GET", "/hello", async (_req, reply) => {
    reply.send({ integration: "alpha", message: "hello" });
  });

  ctx.registerRoute("GET", "/greet/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    reply.send({ greeting: `hello ${name}` });
  });

  ctx.registerRoute("GET", "/no-send", async (_req, _reply) => {
    // Intentionally returns without calling reply.send() — exercises the
    // no-send safety net in the dispatcher.
  });

  ctx.registerRoute("GET", "/echo-header", async (req, reply) => {
    reply.send({ ifNoneMatch: req.headers["if-none-match"] ?? null });
  });
}
