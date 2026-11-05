import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { OpsClient } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeControlInstallation,
  openControlInstallation,
} from "../packages/core/src/build-artifacts";
import {
  createCatalogPinSet,
  initializeManagedCatalogPins,
  readCatalogPinSet,
  readCatalogProposal,
} from "../packages/core/src/catalog-pins";
import {
  decodeGbfsCatalogLock,
  decodeTransitousLock,
} from "../packages/transitous-core/src/catalog-pins";
import {
  buildRuntimeBundle,
  RUNTIME_BUNDLES,
  writeRuntimeBundle,
} from "./build-runtime-bundles.mjs";

/**
 * The running bundled agent retains signed paired-pin proposals without
 * activating them. A managed pair is initialized before compatibility files
 * are planted in a checkout created under umask 002; those files cannot
 * replace the pair or supply an approvable proposal, including after restart.
 */
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const agents: ChildProcess[] = [];
let outdir = "";

const CANDIDATE = `main@${"c".repeat(40)}`;
const PLANTED = `main@${"e".repeat(40)}`;
const releasePin = () =>
  decodeTransitousLock(
    JSON.parse(readFileSync(join(ROOT, "infra", "docker", "transitous.lock.json"), "utf8")),
  );

const supported = process.platform === "linux" || process.platform === "darwin";

describe.skipIf(!supported)("the agent's Transitous pin", () => {
  beforeAll(async () => {
    mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
    outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "transitous-pin-"));
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

  /** A rendered checkout under umask 002, with a pin and a proposal planted in infra/docker. */
  async function checkout(): Promise<string> {
    const clone = mkdtempSync(join(tmpdir(), "openmapx-transitous-pin-"));
    roots.push(clone);
    const target = join(clone, "checkout");
    const previous = process.umask(0o002);
    try {
      await run("git", ["clone", "-q", "--no-local", ROOT, target]);
    } finally {
      process.umask(previous);
    }
    const infra = join(target, "infra", "docker");
    // Git-created directories inherit the deliberately permissive clone umask.
    // Provision the fixture's authority roots explicitly, as a host operator
    // must, rather than teaching production to accept group-writable trust.
    chmodSync(target, 0o755);
    chmodSync(join(target, "infra"), 0o755);
    chmodSync(infra, 0o755);
    chmodSync(join(infra, "secrets"), 0o700);
    // The deployment's user, which a host render writes from the checkout's
    // owner; the bundled CLI is the agent's and only reads it.
    const owner = statSync(target);
    writeFileSync(
      join(infra, ".env"),
      `UID=${owner.uid}\nGID=${owner.gid}\nPOSTGRES_PASSWORD=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nDATA_MANAGER_AUTH_TOKEN=${secret()}\nOPENMAPX_HOST_DIR=${target}\n`,
      { mode: 0o600 },
    );
    const rendered = await cli(target, "compose", "render");
    expect(rendered.stdout).toContain("Rendered");
    // The one-time operator bootstrap imports both exact source pins. They
    // must be trusted files before the fixture replaces compatibility files.
    for (const name of ["transitous.lock.json", "gbfs-catalog.lock.json"])
      chmodSync(join(infra, name), 0o600);
    const installation = openControlInstallation({
      infraDir: infra,
      role: "host-cli",
      serviceIds: ["motis"],
    });
    try {
      await initializeManagedCatalogPins({ rootDir: target, installation });
    } finally {
      closeControlInstallation(installation);
    }
    const planted = JSON.stringify({
      ref: PLANTED,
      submodules: {},
      lockedAt: "2026-01-01T00:00:00.000Z",
      lockedBy: "another account",
    });
    writeFileSync(join(infra, "transitous.lock.json"), planted);
    writeFileSync(join(infra, "transitous.lock.proposed.json"), planted);
    return target;
  }

  async function cli(target: string, ...args: string[]) {
    return run(process.execPath, [join(outdir, "cli.mjs"), ...args], {
      cwd: target,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: target },
    });
  }

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

  async function startAgent(target: string) {
    const infra = join(target, "infra", "docker");
    const port = await freePort();
    const agent = spawn(process.execPath, [join(outdir, "agent.mjs")], {
      cwd: target,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENMAPX_ROOT_DIR: target,
        OPS_AGENT_API_TOKEN_FILE: join(infra, "secrets", "ops-agent-api-token"),
        OPS_AGENT_DATA_MANAGER_TOKEN_FILE: join(infra, "secrets", "ops-agent-data-manager-token"),
        OPS_TRUSTED_CONFIG_DIR: services.agentStatePaths(infra).trustedConfig,
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
    const client = new OpsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      tokenFile: join(infra, "secrets", "ops-agent-data-manager-token"),
    });
    const execute = async (operation: Parameters<OpsClient["execute"]>[0]) => {
      const admission = await client.execute(operation, {
        operationKey: `opk1_${randomBytes(18).toString("base64url").slice(0, 32)}`,
      });
      if (admission.execution !== "sync") throw new Error("expected a synchronous operation");
      return admission.value as Record<string, unknown>;
    };
    const stop = async () => {
      agent.kill("SIGTERM");
      await new Promise((done) => agent.once("exit", done));
    };
    return { execute, stop };
  }

  it("retains signed paired proposals across restart and refuses raw approval without changing pins", async () => {
    const target = await checkout();
    const infra = join(target, "infra", "docker");
    const trackedBefore = readFileSync(join(infra, "transitous.lock.json"), "utf8");
    const release = releasePin();
    const active = readCatalogPinSet(target);
    if (!active) throw new Error("Expected the managed bootstrap pair");
    expect(active.transitous).toEqual(release);
    expect(active.gbfs).toEqual(
      decodeGbfsCatalogLock(
        JSON.parse(readFileSync(join(ROOT, "infra/docker/gbfs-catalog.lock.json"), "utf8")),
      ),
    );

    const agent = await startAgent(target);
    expect(await agent.execute({ kind: "catalogPins.inspect" })).toEqual({
      active,
      catalogRevisionId: active.generationId,
    });
    const proposalId = randomUUID();
    const pins = createCatalogPinSet(
      {
        ...active.transitous,
        ref: CANDIDATE,
        submodules: { "transitland-atlas": "d".repeat(40) },
        lockedBy: "auto-bump",
      },
      active.gbfs,
    );
    const proposal = {
      proposalId,
      baseGenerationId: active.generationId,
      pins,
      diffDigest: "a".repeat(64),
      sourcePolicyRevision: "b".repeat(64),
    };
    expect(
      await agent.execute({
        kind: "transitousLock.propose",
        ...proposal,
      }),
    ).toEqual({ proposalId, proposed: true, catalogRevisionId: pins.generationId });
    expect(
      await agent.execute({ kind: "transitousLock.inspect", proposalId, offset: 0 }),
    ).toMatchObject({
      active: active.transitous,
      proposal: { ...proposal, state: "proposed" },
      page: { total: 1, nextOffset: null },
    });
    const installation = openControlInstallation({ infraDir: infra, role: "ops-agent" });
    try {
      // Reads and verifies the signature from the actual running agent's proposal.
      expect(readCatalogProposal({ rootDir: target, installation, proposalId })).toMatchObject({
        ...proposal,
        state: "proposed",
      });
    } finally {
      closeControlInstallation(installation);
    }
    const proposalFile = join(infra, "catalog-pins", "proposals", `${proposalId}.json`);
    const retained = readFileSync(proposalFile);
    // Raw-ref approval is unsupported. Successful paired activation is covered
    // by the actual catalog-workflow-postgres worker/agent acceptance.
    await expect(
      agent.execute({
        kind: "transitousLock.approve",
        ref: CANDIDATE,
        approvedBy: "admin",
      } as never),
    ).rejects.toMatchObject({ errorClass: "validation", status: 400 });
    expect(readCatalogPinSet(target)).toEqual(active);
    expect(readFileSync(join(infra, "transitous.lock.json"), "utf8")).toBe(trackedBefore);
    expect(existsSync(join(infra, "transitous.lock.proposed.json"))).toBe(true);
    await agent.stop();

    const restarted = await startAgent(target);
    expect(await restarted.execute({ kind: "catalogPins.inspect" })).toEqual({
      active,
      catalogRevisionId: active.generationId,
    });
    expect(
      await restarted.execute({ kind: "transitousLock.inspect", proposalId, offset: 0 }),
    ).toMatchObject({
      proposal: { ...proposal, state: "proposed" },
      page: { total: 1, nextOffset: null },
    });
    expect(readFileSync(proposalFile)).toEqual(retained);
    expect(readdirSync(join(infra, "catalog-pins", "proposals"))).toEqual([`${proposalId}.json`]);
    expect(readFileSync(join(infra, "transitous.lock.json"), "utf8")).toBe(trackedBefore);
    await restarted.stop();
  }, 180_000);
});
