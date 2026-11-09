import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const turbo = resolve(
  dirname(createRequire(import.meta.url).resolve("turbo/package.json")),
  "bin/turbo",
);
function graph(id: string, tasks: string[] = ["build", "build:deploy"]) {
  const result = JSON.parse(
    execFileSync(process.execPath, [turbo, "run", ...tasks, "--dry=json"], {
      cwd: root,
      env: { ...process.env, SW_BUILD_ID: id, TURBO_TELEMETRY_DISABLED: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  return new Map<string, string>(
    result.tasks.map((task: { taskId: string; hash: string }) => [task.taskId, task.hash]),
  );
}
describe("service-worker identity cache isolation", () => {
  it("invalidates Next compilation for integration sources outside the web workspace", () => {
    const probe = resolve(root, "integrations/ci-cache-input-probe.ts");
    try {
      writeFileSync(probe, "export const value = 1;\n");
      const first = graph("same-deployment");
      writeFileSync(probe, "export const value = 2;\n");
      expect(graph("same-deployment").get("web#build:app")).not.toBe(first.get("web#build:app"));
    } finally {
      rmSync(probe, { force: true });
    }
  });
  it("changes deployment output hashes without invalidating Next compilation or unrelated package builds", () => {
    const first = graph("deployment-one"),
      second = graph("deployment-two");
    expect(first.get("web#build:app")).toBeTruthy();
    expect(first.get("web#build:app")).toBe(second.get("web#build:app"));
    expect(first.get("web#build:deploy")).toBeTruthy();
    expect(first.get("web#build:deploy")).not.toBe(second.get("web#build:deploy"));
    const others = [...first.keys()].filter(
      (key) => key.endsWith("#build") && !key.startsWith("web#"),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const key of others) expect(first.get(key), key).toBe(second.get(key));
  });
});

describe("web type-check cache inputs", () => {
  it("invalidates the web type check for integration sources it compiles from outside the workspace", () => {
    const probe = resolve(root, "integrations/ci-cache-input-probe.tsx");
    const hash = () =>
      graph("same-deployment", ["check-types", "--filter=web"]).get("web#check-types");
    try {
      writeFileSync(probe, "export const value = 1;\n");
      const first = hash();
      writeFileSync(probe, "export const value = 2;\n");
      expect(first).toBeTruthy();
      expect(hash()).not.toBe(first);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
