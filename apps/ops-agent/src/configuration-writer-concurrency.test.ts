import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-writers-"));
  roots.push(root);
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  // The deployment's user, which only a host render writes into .env.
  writeFileSync(
    join(root, "infra/docker/.env"),
    `UID=${process.geteuid?.() ?? 0}\nGID=${process.getegid?.() ?? 0}\n`,
    { mode: 0o600 },
  );
  mkdirSync(join(root, "services/alpha"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    join(root, "services/alpha/service.json"),
    JSON.stringify({
      id: "alpha",
      name: "Alpha",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "example/alpha", tag: "1" },
      configSchema: { type: "object", properties: { label: { type: "string" } } },
    }),
  );
  const selection = coreServices.serviceSelectionPath(join(root, "infra/docker"));
  mkdirSync(dirname(selection), { recursive: true, mode: 0o700 });
  writeFileSync(selection, '{"selected":["alpha"]}', { mode: 0o600 });
  return root;
}
function start(root: string, mode: string, letter = "a", expected = "", hold = "") {
  const messages: Array<{ event: string; result?: unknown; message?: string }> = [];
  let stderr = "";
  const child = fork(
    join(import.meta.dirname, "__fixtures__/configuration-writer.mjs"),
    [root, mode, letter, expected, hold],
    {
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx/esm")],
      silent: true,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        POSTGRES_PASSWORD: "x".repeat(24),
        BETTER_AUTH_SECRET: "a".repeat(32),
        DATA_MANAGER_AUTH_TOKEN: "b".repeat(32),
      },
    },
  );
  children.push(child);
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  child.on("message", (message) => messages.push(message as (typeof messages)[number]));
  const wait = async (event: string) => {
    const deadline = performance.now() + 10_000;
    while (!messages.some((m) => m.event === event)) {
      if (
        messages.some((m) => m.event === "error") ||
        child.exitCode !== null ||
        performance.now() > deadline
      )
        throw new Error(JSON.stringify(messages) + stderr);
      await delay(10);
    }
    const message = messages.find((m) => m.event === event);
    if (!message) throw new Error("Missing child event");
    return message;
  };
  return { child, messages, wait, release: () => child.send("release") };
}
const rev = (s: string) => `cfg1_${s.repeat(43)}`;
describe("overlapping configuration writers", () => {
  it("rejects a captured initial host snapshot after a separate CLI writer has completed", async () => {
    const root = fixture();
    const infra = join(root, "infra/docker");
    const a = start(root, "ops", "a", "", "captured");
    await a.wait("held");
    const cli = start(root, "cli");
    await cli.wait("done");
    const completed = coreServices.currentConfigurationGeneration(infra);
    expect(completed).not.toBeNull();
    a.release();
    expect((await a.wait("done")).result).toMatchObject({
      outcome: "not_committed",
      reason: "conflict",
      currentRevisionId: completed,
    });
    expect(coreServices.currentConfigurationGeneration(infra)).toBe(completed);
    expect(coreServices.readAppliedConfiguration(infra).serviceConfigs).toEqual([]);
  }, 20_000);
  it("holds CLI read/staging and startup cleanup outside a host writer's staging and follow-up interval", async () => {
    const root = fixture();
    const infra = join(root, "infra/docker");
    const a = start(root, "ops", "a", "", "before");
    await a.wait("held");
    const staging = readdirSync(join(infra, coreServices.CONFIGURATION_GENERATIONS)).filter((n) =>
      n.endsWith(".tmp"),
    );
    expect(staging).toHaveLength(1);
    const cli = start(root, "cli");
    const init = start(root, "initialize");
    await Promise.all([cli.wait("started"), init.wait("started")]);
    await delay(150);
    expect(cli.messages.some((m) => m.event === "done")).toBe(false);
    expect(init.messages.some((m) => m.event === "done")).toBe(false);
    expect(readdirSync(join(infra, coreServices.CONFIGURATION_GENERATIONS))).toEqual(staging);
    a.release();
    await a.wait("done");
    await Promise.all([cli.wait("done"), init.wait("done")]);
    expect(coreServices.readAppliedConfiguration(infra).serviceConfigs[0]?.values.label).toBe("a");
    expect(
      readFileSync(
        join(infra, coreServices.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
        "utf8",
      ),
    ).toContain("label: a");
  }, 20_000);
  it("rejects an overlapping compensation after B completes and preserves B follow-up files", async () => {
    const root = fixture();
    const infra = join(root, "infra/docker");
    await start(root, "ops", "a").wait("done");
    const b = start(root, "ops", "b", rev("a"), "after");
    await b.wait("held");
    const routes = readFileSync(
      join(infra, "state/ops-agent/traefik/dynamic/generated-routes.yml"),
      "utf8",
    );
    const compensation = start(root, "ops", "c", rev("a"));
    await compensation.wait("started");
    await delay(150);
    expect(compensation.messages.some((m) => m.event === "done")).toBe(false);
    b.release();
    await b.wait("done");
    expect((await compensation.wait("done")).result).toMatchObject({
      outcome: "not_committed",
      reason: "conflict",
      currentRevisionId: rev("b"),
    });
    expect(coreServices.readAppliedConfiguration(infra).serviceConfigs[0]?.values.label).toBe("b");
    expect(
      readFileSync(join(infra, "state/ops-agent/traefik/dynamic/generated-routes.yml"), "utf8"),
    ).toBe(routes);
  }, 20_000);
  it("holds pruning outside a contender's completed-generation activation interval", async () => {
    const root = fixture();
    const infra = join(root, "infra/docker");
    const registry = new coreServices.ServiceRegistry({ rootDir: root });
    await registry.load();
    for (let n = 0; n < 16; n++)
      await coreServices.commitConfigurationGeneration({
        infraDir: infra,
        services: registry.list(),
        // This pruning fixture has no containers. Supply the complete empty
        // inventory; omitted evidence correctly preserves conservative bases.
        ownedServiceGenerations: [],
        observedServiceContainerIds: [],
        input: {
          domain: "fixture.example.test",
          selectedRoots: ["alpha"],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
      });
    const a = start(root, "ops", "a", "", "renamed");
    await a.wait("held");
    const init = start(root, "initialize");
    await init.wait("started");
    await delay(150);
    expect(init.messages.some((m) => m.event === "done")).toBe(false);
    expect(readdirSync(join(infra, coreServices.CONFIGURATION_GENERATIONS))).toHaveLength(16);
    a.release();
    await a.wait("done");
    await init.wait("done");
    expect(coreServices.currentConfigurationGeneration(infra)).toBe(rev("a"));
    expect(coreServices.readAppliedConfiguration(infra).serviceConfigs[0]?.values.label).toBe("a");
    expect(readdirSync(join(infra, coreServices.CONFIGURATION_GENERATIONS))).toHaveLength(15);
  }, 20_000);
  it("never writes after a contender times out, even when the live holder subsequently releases", async () => {
    const root = fixture();
    const infra = join(root, "infra/docker");
    const a = start(root, "ops", "a", "", "before");
    await a.wait("held");
    const b = start(root, "ops", "b");
    expect((await b.wait("done")).result).toMatchObject({
      outcome: "not_committed",
      reason: "busy",
    });
    a.release();
    await a.wait("done");
    await delay(150);
    expect(coreServices.currentConfigurationGeneration(infra)).toBe(rev("a"));
    expect(coreServices.readAppliedConfiguration(infra).serviceConfigs[0]?.values.label).toBe("a");
    expect((await start(root, "ops", "c").wait("done")).result).toMatchObject({
      outcome: "committed",
    });
  }, 20_000);
  it("does not steal a killed holder's ownership or allow a timed-out contender to write later", async () => {
    const root = fixture();
    const infra = join(root, "infra/docker");
    const a = start(root, "ops", "a", "", "before");
    await a.wait("held");
    a.child.kill("SIGKILL");
    await new Promise<void>((resolve) => a.child.once("exit", () => resolve()));
    const b = start(root, "ops", "b");
    expect((await b.wait("done")).result).toMatchObject({
      outcome: "not_committed",
      reason: "busy",
    });
    expect(coreServices.currentConfigurationGeneration(infra)).toBeNull();
    expect(
      readdirSync(join(infra, coreServices.CONFIGURATION_GENERATIONS)).some((n) =>
        n.endsWith(".tmp"),
      ),
    ).toBe(true);
  }, 20_000);
});
