import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "../index.js";

const COLOGNE = [6.96, 50.94];
const BONN = [7.1, 50.73];

type MockContext = ReturnType<typeof createMockIntegrationContext>;

function newContext(): MockContext {
  const ctx = createMockIntegrationContext();
  setup(ctx);
  return ctx;
}

async function post(ctx: MockContext, body: unknown) {
  const route = ctx.registered.routes.find(
    (entry) => entry.method === "POST" && entry.path === "/directions/schedule",
  );
  if (!route) throw new Error("POST /directions/schedule was not registered");
  const sent: { status: number; payload: unknown } = { status: 200, payload: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header() {
      return reply;
    },
    send(payload: unknown) {
      sent.payload = payload;
      return reply;
    },
  };
  await route.handler({ body } as never, reply as never);
  return sent;
}

describe("POST /directions/schedule", () => {
  it("is registered", () => {
    const ctx = newContext();
    expect(
      ctx.registered.routes.some(
        (entry) => entry.method === "POST" && entry.path === "/directions/schedule",
      ),
    ).toBe(true);
  });

  it("rejects a malformed body with 400 and the reason", async () => {
    const sent = await post(newContext(), { waypoints: [COLOGNE] });
    expect(sent.status).toBe(400);
    expect(sent.payload).toMatchObject({ error: expect.stringContaining("2-25") });
  });

  it("rejects optimize on a windowed trip with 422 and a machine reason", async () => {
    const sent = await post(newContext(), {
      waypoints: [COLOGNE, BONN, COLOGNE],
      schedules: [null, { arriveBy: "2026-09-01T14:00" }, null],
      optimize: true,
    });
    expect(sent.status).toBe(422);
    expect(sent.payload).toMatchObject({ reason: "window-constraints-not-optimizable" });
  });

  it("returns 503 when no routing provider is registered", async () => {
    const sent = await post(newContext(), { waypoints: [COLOGNE, BONN] });
    expect(sent.status).toBe(503);
  });
});
