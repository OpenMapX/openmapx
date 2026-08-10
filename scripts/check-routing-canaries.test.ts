import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type RoutingCanary, validateRoutingCanary } from "./check-routing-canaries";

const execFileAsync = promisify(execFile);

const CANARY: RoutingCanary = {
  name: "control",
  waypoints: "0,0;1,1",
  minimumRoutes: 2,
  requireBaseline: true,
};

describe("validateRoutingCanary", () => {
  it("accepts multiple routes when baseline is greater than live duration", () => {
    expect(
      validateRoutingCanary(CANARY, {
        routes: [
          { duration: 600, baselineDuration: 620 },
          { duration: 700, baselineDuration: 710 },
        ],
      }),
    ).toEqual([]);
  });

  it("requires the configured minimum route count", () => {
    expect(
      validateRoutingCanary(CANARY, { routes: [{ duration: 600, baselineDuration: 620 }] }),
    ).toEqual(["control: expected at least 2 route(s), received 1"]);
  });

  it("rejects missing or invalid duration fields", () => {
    expect(
      validateRoutingCanary(CANARY, {
        routes: [
          { duration: 0, baselineDuration: null },
          { duration: Number.NaN, baselineDuration: -1 },
        ],
      }),
    ).toEqual([
      "control: route 1 has no finite baseline duration",
      "control: route 2 has no finite live duration",
      "control: route 2 has no finite baseline duration",
    ]);
  });
});

describe("routing canary CLI entrypoint", () => {
  it("runs through the CLI workspace when the root script is transformed as CommonJS", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          routes: [
            { duration: 600, baselineDuration: 620, distance: 1_000 },
            { duration: 700, baselineDuration: 710, distance: 1_200 },
          ],
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IP socket address for the routing fixture");
      }

      const { stdout } = await execFileAsync(
        "pnpm",
        ["-C", "packages/cli", "exec", "tsx", "../../scripts/check-routing-canaries.ts"],
        {
          env: {
            ...process.env,
            ROUTING_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      );

      expect(stdout).toContain(
        "Routing canaries passed: alternate availability and baseline fields are healthy.",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
