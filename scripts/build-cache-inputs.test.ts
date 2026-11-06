import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const turbo = resolve(
  dirname(createRequire(import.meta.url).resolve("turbo/package.json")),
  "bin/turbo",
);
function graph(id: string) {
  const result = JSON.parse(
    execFileSync(process.execPath, [turbo, "run", "build", "build:deploy", "--dry=json"], {
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
