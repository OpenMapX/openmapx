import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("engine-owned traffic watchdog", () => {
  it("validates offline clearing and the serving lease using the production Python module", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    expect(() =>
      execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", directory], {
        timeout: 20_000,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
  it("runs as the engine entrypoint and shares only the traffic state directory", () => {
    const service = JSON.parse(readFileSync(new URL("../service.json", import.meta.url), "utf8"));
    expect(service.container.entrypoint).toEqual(["python3", "/opt/openmapx/traffic-watchdog.py"]);
    expect(service.container.command).toEqual(["build_tiles"]);
    expect(service.bindMounts).toContainEqual({
      source: "@infra:data/traffic",
      target: "/traffic-state",
      readOnly: false,
    });
    const config = JSON.parse(
      readFileSync(new URL("../config/valhalla.json", import.meta.url), "utf8"),
    );
    expect(config.httpd.service.listen).toBe("tcp://127.0.0.1:8004");
    expect(service.container.expose).toEqual([8002]);
    expect(service.container.healthcheck.port).toBe(8002);
  });
});
