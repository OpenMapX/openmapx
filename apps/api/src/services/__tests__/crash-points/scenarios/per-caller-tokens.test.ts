import { expect } from "vitest";
import { crashScenario } from "../scenario";

const MAINTENANCE = "00000000-0000-4000-8000-000000000000";
// Routes only the operations agent and the host CLI use.
const AGENT_ROUTES: [string, string][] = [
  ["POST", "/executions/configuration-maintenance/prepare"],
  ["POST", "/executions/configuration-maintenance/recovery"],
  ["GET", `/executions/configuration-maintenance/${MAINTENANCE}`],
  ["POST", `/executions/configuration-maintenance/${MAINTENANCE}/settle`],
  ["POST", "/executions/generation-hardlinks"],
  ["POST", "/executions/generation-hardlinks/recovery"],
];

// The API, which faces the network, holds its own data-manager token, and it
// reaches none of the routes the operations agent drives.
crashScenario({
  title: "data-manager routes called with the API's token",
  name: "are refused with 403 and change nothing",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const start = host.mark();
    for (const [method, path] of AGENT_ROUTES) {
      const reply = await host.callDataManager(
        "api",
        method,
        path,
        method === "GET" ? undefined : {},
      );
      expect({ method, path, status: reply.status, body: reply.body }).toEqual({
        method,
        path,
        status: 403,
        body: { error: "This caller may not use this route" },
      });
    }
    // The agent's token reaches the same route; it is refused only for its body.
    expect((await host.callDataManager("ops-agent", "POST", AGENT_ROUTES[0][1], {})).status).toBe(
      400,
    );
    // Nothing was started or fenced.
    expect(host.dockerEffects({ since: start })).toEqual([]);
    expect((await host.submitDataJob()).status).toBe(200);
  },
});
