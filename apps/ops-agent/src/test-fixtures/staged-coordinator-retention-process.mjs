/** Native production assembly; only named Docker inventory/cache and the
 * filesystem acknowledgement fault are controlled by the owning test. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let rawInput = "";
for await (const chunk of process.stdin) rawInput += chunk;
const input = JSON.parse(rawInput);
Date.now = () => input.now;
let faulted = false,
  packetBundle;
const originalUnlink = fs.unlinkSync;
if (input.mode === "fault") {
  fs.unlinkSync = (path) => {
    const same =
      typeof path === "string" &&
      basename(path) === basename(input.firstPullPath) &&
      fs.statSync(dirname(path), { bigint: true }).dev ===
        fs.statSync(dirname(input.firstPullPath), { bigint: true }).dev &&
      fs.statSync(dirname(path), { bigint: true }).ino ===
        fs.statSync(dirname(input.firstPullPath), { bigint: true }).ino;
    if (same && !faulted) {
      packetBundle = {
        publicKey: JSON.parse(
          fs.readFileSync(join(input.infraDir, "secrets/control-verifiers.json"), "utf8"),
        ).publicKeys["ops-agent"],
        candidate: JSON.parse(fs.readFileSync(join(input.firstSlot, "proof.json"), "utf8")),
        progress: JSON.parse(fs.readFileSync(join(input.firstSlot, "progress.json"), "utf8")),
        manifest: JSON.parse(fs.readFileSync(join(input.firstSlot, "manifest.json"), "utf8")),
        decision: JSON.parse(fs.readFileSync(join(input.firstSlot, "commit.json"), "utf8")),
      };
      originalUnlink(path);
      faulted = true;
      throw Error("Named external filesystem acknowledgement lost after actual first F unlink");
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
}
// Dynamic imports intentionally follow installation of the native FS edge.
const core = await import("@openmapx/core/build-artifacts");
const { services } = await import("@openmapx/core/server");
const { CommunityRepositoryStore } = await import("../community-repositories.ts");
const { createProductionOpsRuntime, productionOwnedServices } = await import(
  "../production-runtime.ts"
);
const { createTrustedConfigurationAuthorityLoader } = await import(
  "../trusted-configuration-authority.ts"
);
const { openOpsJobJournal } = await import("../journal.ts");
const { buildOpsAgentServer } = await import("../server.ts");
const { runContainedProcess } = await import("../docker-runtime.ts");
if (
  !Array.isArray(input.serviceIds) ||
  input.serviceIds.length > 256 ||
  input.serviceIds.some((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
)
  throw Error("Invalid fixed fixture registry");
const builtInServices = input.serviceIds.map((id) => ({
  manifest: JSON.parse(fs.readFileSync(join(input.root, "services", id, "service.json"), "utf8")),
  directory: join(input.root, "services", id),
  enabled: true,
  isBuiltIn: true,
}));
const loadAuthority = createTrustedConfigurationAuthorityLoader({
  rootDir: input.root,
  builtInServices,
});
const repositories = new CommunityRepositoryStore({ rootDir: input.root });
await repositories.recover();
const runtime = await createProductionOpsRuntime({
  rootDir: input.root,
  stack: input.stack,
  loadAuthority,
  communityRepositories: repositories,
  candidateSource: {
    directory: input.queue,
    token: input.token,
    ownerUid: fs.statSync(input.queue).uid,
    ownerGid: fs.statSync(input.queue).gid,
  },
  docker: {
    fileExists: fs.existsSync,
    execFile: async (file, args, options) => {
      if (file !== "docker") throw Error("Only fixed Docker IO expected");
      if (args[0] === "container" && args[1] === "ls")
        return { stdout: input.rows.map((row) => row.Id).join("\n") };
      if (args[0] === "container" && args[1] === "inspect")
        return { stdout: input.rows.map((row) => JSON.stringify(row)).join("\n") };
      if (args[0] === "image" && args[1] === "inspect") {
        const image = input.images[args.at(-1)];
        if (!image) throw Error("Unknown named Docker cache observation");
        return { stdout: image };
      }
      if (args[0] === "compose" && args.includes("config"))
        return runContainedProcess(file, args, options);
      throw Error("GC must not issue a Docker mutation");
    },
  },
});
const installation = core.openControlInstallation({
  infraDir: input.infraDir,
  role: "ops-agent",
  serviceIds: input.serviceIds,
});
const journal = await openOpsJobJournal(join(input.infraDir, "data/ops-agent/jobs-v1.json"));
const app = buildOpsAgentServer({
  runtime,
  journal,
  controlInstallation: installation,
  tokens: { api: input.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
});
await app.ready();
let retired = 0,
  pending = 0;
for (let pass = 0; pass < 12; pass++) {
  if (input.mode === "fault" && faulted) break;
  const result = await core.reconcileControlRetention(installation, { maxFamilies: 64 });
  retired += result.retired;
  pending = result.pending;
  if (input.mode === "fault" && faulted) break;
  await delay(0);
}
if (input.mode === "fault") {
  const until = performance.now() + 10000;
  while (
    fs.existsSync(join(input.infraDir, "control-private/ops-agent/.retention-reconcile-writer"))
  ) {
    if (performance.now() > until)
      throw Error("Original collector did not release its guard after IO loss");
    await delay(10);
  }
  if (!faulted || !packetBundle) {
    const p = fs.existsSync(join(input.firstSlot, "progress.json"))
      ? JSON.parse(fs.readFileSync(join(input.firstSlot, "progress.json"), "utf8"))
      : null;
    throw Error(
      `Actual first F unlink fault not reached: ${JSON.stringify({ retired, pending, Fpresent: fs.existsSync(input.firstPullPath), Gpresent: fs.existsSync(input.secondPullPath), phase: p?.phase, lastError: p?.lastError ?? null })}`,
    );
  }
  if (input.evidenceFile)
    fs.writeFileSync(input.evidenceFile, JSON.stringify(packetBundle, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  process.stdout.write(
    JSON.stringify({
      boundary: "actual-first-F-private-unlink",
      faulted,
      Fpresent: fs.existsSync(input.firstPullPath),
      Gpresent: fs.existsSync(input.secondPullPath),
      FslotPresent: fs.existsSync(input.firstSlot),
      journalKeys: journal.records().map((job) => job.operationKey),
    }) + "\n",
  );
  process.kill(process.pid, "SIGSTOP");
  throw Error("Stopped native fixture resumed unexpectedly");
}
const owned = await productionOwnedServices(runtime).inspectOwnedServices(
  new AbortController().signal,
);
process.stdout.write(
  JSON.stringify({
    boundary: "native-retirement-observation",
    retired,
    pending,
    Fpresent: fs.existsSync(input.firstPullPath),
    Gpresent: fs.existsSync(input.secondPullPath),
    FslotPresent: fs.existsSync(input.firstSlot),
    journalKeys: journal.records().map((job) => job.operationKey),
    ordinaryOwnedDM: owned.some((service) => service.serviceId === "data-manager"),
  }) + "\n",
);
await app.close();
core.closeControlInstallation(installation);
