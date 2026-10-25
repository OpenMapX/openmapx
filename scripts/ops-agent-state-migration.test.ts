import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { OpsClient, opsOperationFingerprint, opsResourceId } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openOpsJobJournal } from "../apps/ops-agent/src/journal";
import {
  buildRuntimeBundle,
  RUNTIME_BUNDLES,
  writeRuntimeBundle,
} from "./build-runtime-bundles.mjs";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const agents: ChildProcess[] = [];
let outdir = "";

beforeAll(async () => {
  mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
  outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "state-migration-"));
  writeRuntimeBundle(
    await buildRuntimeBundle(ROOT, "ops-agent", {
      ...RUNTIME_BUNDLES["ops-agent"],
      outdir: relative(ROOT, outdir),
    }),
  );
}, 120_000);

afterAll(() => {
  for (const agent of agents.splice(0)) agent.kill("SIGKILL");
  if (outdir) rmSync(outdir, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const secret = () => randomBytes(24).toString("base64url");

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolvePort(address.port) : reject(new Error()),
      );
    });
  });
}

const operation = { kind: "backup.create", backupId: "nightly-20261020" } as const;
const operationKey = `opk1_${"b".repeat(24)}`;

describe("an existing host's agent state", () => {
  it("moves out of data-manager's data directory, keeping the unfinished job", async () => {
    const parent = mkdtempSync(join(tmpdir(), "openmapx-state-migration-"));
    roots.push(parent);
    const checkout = join(parent, "checkout");
    await run("git", ["clone", "-q", ROOT, checkout]);
    const infra = join(checkout, "infra", "docker");
    writeFileSync(
      join(infra, ".env"),
      `POSTGRES_PASSWORD=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nDATA_MANAGER_AUTH_TOKEN=${secret()}\nOPENMAPX_HOST_DIR=${checkout}\n`,
      { mode: 0o600 },
    );

    // What the previous release left: its journal with a job still running,
    // the trusted-config queue and privacy scratch it mounted, and a handoff
    // record data-manager could have planted, whose overlay a rollback would
    // restore.
    const legacy = services.legacyAgentStatePaths(infra);
    mkdirSync(legacy.trustedConfig, { recursive: true, mode: 0o700 });
    mkdirSync(legacy.privacyExtraction, { recursive: true, mode: 0o700 });
    await (await openOpsJobJournal(legacy.journal)).replace([
      {
        role: "api",
        operation,
        operationId: `job1_${"a".repeat(24)}`,
        operationKey,
        fingerprint: opsOperationFingerprint(operation),
        resourceId: opsResourceId(operation),
        state: "running",
        submittedAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-20T10:00:01.000Z",
      },
    ]);
    writeFileSync(
      legacy.handoff,
      JSON.stringify({
        version: 1,
        handoffId: "planted-handoff",
        releaseId: "planted-release",
        digest: "c".repeat(64),
        phase: "recreated",
        previousOverlay: "services:\n  app-api:\n    image: attacker.invalid/app-api\n",
        createdAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-20T10:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const queue = statSync(legacy.trustedConfig).ino;

    // The first render of this release mounts the queue from its new place.
    const rendered = await run(process.execPath, [join(outdir, "cli.mjs"), "compose", "render"], {
      cwd: checkout,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: checkout },
    });
    expect(rendered.stdout).toContain("Rendered");
    const current = services.agentStatePaths(infra);
    expect(statSync(current.trustedConfig).ino).toBe(queue);
    expect(existsSync(legacy.trustedConfig)).toBe(false);
    expect(existsSync(legacy.privacyExtraction)).toBe(false);
    const pointer = join(infra, services.CURRENT_CONFIGURATION);
    const compose = readFileSync(join(pointer, "docker-compose.generated.yml"), "utf8");
    // Compose resolves mounts from the pointer: `../../trusted-config`.
    expect(compose).toContain(
      `${relative(pointer, current.trustedConfig)}:/var/lib/openmapx/trusted-config`,
    );
    expect(relative(pointer, current.trustedConfig)).toBe("../../trusted-config");
    expect(compose).not.toContain("data/ops-agent");

    const port = await freePort();
    const agent = spawn(process.execPath, [join(outdir, "agent.mjs")], {
      cwd: checkout,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENMAPX_ROOT_DIR: checkout,
        OPS_AGENT_API_TOKEN_FILE: join(infra, "secrets", "ops-agent-api-token"),
        OPS_AGENT_DATA_MANAGER_TOKEN_FILE: join(infra, "secrets", "ops-agent-data-manager-token"),
        OPS_TRUSTED_CONFIG_DIR: current.trustedConfig,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agents.push(agent);
    let output = "";
    agent.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    agent.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (agent.exitCode !== null) throw new Error(`The agent exited: ${output}`);
      const healthy = await fetch(`http://127.0.0.1:${port}/health`)
        .then((response) => response.ok)
        .catch(() => false);
      if (healthy) break;
      if (Date.now() > deadline) throw new Error(`The agent never became healthy: ${output}`);
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(output).toContain("journal imported, handoff record discarded");

    const client = new OpsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      tokenFile: join(infra, "secrets", "ops-agent-api-token"),
    });
    await expect(client.lookup(operation, operationKey)).resolves.toMatchObject({
      operationKey,
      kind: "backup.create",
    });
    const handoff = await client.execute({
      kind: "agent.handoff.inspect",
      handoffId: "planted-handoff",
    });
    expect(JSON.stringify(handoff)).toContain('"phase":"none"');
    expect(readFileSync(current.journal, "utf8")).toContain(operationKey);
    agent.kill("SIGTERM");
  }, 120_000);
});
