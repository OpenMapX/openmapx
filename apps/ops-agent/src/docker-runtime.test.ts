import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpsOperation } from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import {
  createDockerRuntime,
  recoverInterruptedTrafficMaintenance,
  runContainedLogProcess,
  runContainedProcess,
} from "./docker-runtime";
import { dispatchOpsOperation } from "./runtime";

const context = () => ({
  signal: new AbortController().signal,
  emitLog: () => undefined,
  claim: {
    fingerprint: "f".repeat(64),
    operation: { kind: "docker.status" } as const,
    source: "registry" as const,
    capability: { revisionId: "registry-v1", values: {} },
  },
});

describe("fixed Docker runtime adapters", () => {
  it.runIf(process.env.OMX_RUN_MOTIS_STOP_CANARY === "1")(
    "confirms real process termination and exclusive promoted-inode ownership in both layouts",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "openmapx-motis-stop-canary-"));
      const ownedIds = new Set<string>();
      const owner = randomUUID();
      const image = "alpine:3.22";
      const command = async (args: readonly string[]) =>
        runContainedProcess("docker", args, {
          signal: AbortSignal.timeout(120_000),
          timeout: 120_000,
          maxBuffer: 64 * 1024,
        });
      const listing = (name: "motis" | "motis-staging") => [
        "container",
        "ls",
        "-a",
        "--no-trunc",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ];
      const remember = async (name: "motis" | "motis-staging", dataPath: string) => {
        const result = (await command(listing(name))).stdout.trim().split("\t");
        expect(result).toHaveLength(2);
        expect(result[0]).toMatch(/^[a-f0-9]{64}$/);
        expect(result[1]).toBe(name);
        const id = result[0] as string;
        expect(
          (
            await command([
              "inspect",
              "--format",
              '{{index .Config.Labels "openmapx.canary.owner"}}',
              id,
            ])
          ).stdout.trim(),
        ).toBe(owner);
        ownedIds.add(id);
        await validateConsumerMounts(id, name, dataPath);
        return id;
      };
      const volumeName = `omx-motis-fs-${owner}`;
      const helperName = `omx-motis-fs-helper-${owner}`;
      let volumeAttempted = false;
      let helperId: string | undefined;
      let mountpoint: string | undefined;
      let acceptedVolume: unknown;
      const mountReceipts: unknown[] = [];
      type Mount = {
        Type: string;
        Name?: string;
        Source: string;
        Destination: string;
        RW: boolean;
      };
      const mountsFor = async (id: string) =>
        JSON.parse(
          (await command(["inspect", "--format", "{{json .Mounts}}", id])).stdout,
        ) as Mount[];
      const volumeInfo = async () => {
        const names = (await command(["volume", "ls", "--format", "{{.Name}}"])).stdout
          .trim()
          .split("\n");
        if (!names.includes(volumeName)) return null;
        const entries = JSON.parse(
          (await command(["volume", "inspect", volumeName])).stdout,
        ) as Array<{
          Name: string;
          Driver: string;
          Mountpoint: string;
          Labels: Record<string, string>;
          Options?: Record<string, string> | null;
        }>;
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (!entry) throw new Error("owned volume inspection missing");
        expect(entry.Name).toBe(volumeName);
        expect(entry.Driver).toBe("local");
        if (entry.Options != null) {
          expect(typeof entry.Options).toBe("object");
          expect(Array.isArray(entry.Options)).toBe(false);
          expect(Object.keys(entry.Options)).toHaveLength(0);
        }
        expect(entry.Labels["openmapx.canary.owner"]).toBe(owner);
        expect(entry.Mountpoint).toMatch(/^\/[^\r\n\0]+$/);
        return entry;
      };
      const containerExists = async (id: string) => {
        const value = (
          await command([
            "container",
            "ls",
            "-a",
            "--no-trunc",
            "--filter",
            `id=${id}`,
            "--format",
            "{{.ID}}",
          ])
        ).stdout.trim();
        if (value === "") return false;
        expect(value).toBe(id);
        return true;
      };
      const cleanup = async (includeHelper = false) => {
        const errors: unknown[] = [];
        const names = includeHelper
          ? ["motis", "motis-staging", helperName]
          : ["motis", "motis-staging"];
        // Recover partial allocation only when both the exact name and owner label match.
        for (const name of names) {
          try {
            const output = (
              await command([
                "container",
                "ls",
                "-a",
                "--no-trunc",
                "--filter",
                `name=^/${name}$`,
                "--format",
                "{{.ID}}\t{{.Names}}",
              ])
            ).stdout.trim();
            if (output === "") continue;
            const fields = output.split("\t");
            expect(fields).toHaveLength(2);
            expect(fields[0]).toMatch(/^[a-f0-9]{64}$/);
            expect(fields[1]).toBe(name);
            const id = fields[0];
            if (!id) throw new Error("owned container ID missing");
            const label = (
              await command([
                "inspect",
                "--format",
                '{{index .Config.Labels "openmapx.canary.owner"}}',
                id,
              ])
            ).stdout.trim();
            if (label === owner) ownedIds.add(id);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const id of ownedIds) {
          if (!includeHelper && id === helperId) continue;
          try {
            if (!(await containerExists(id))) continue;
            expect(
              (
                await command([
                  "inspect",
                  "--format",
                  '{{index .Config.Labels "openmapx.canary.owner"}}',
                  id,
                ])
              ).stdout.trim(),
            ).toBe(owner);
            await command(["rm", "-f", id]);
            expect(await containerExists(id)).toBe(false);
          } catch (error) {
            errors.push(error);
          }
        }
        if (includeHelper && volumeAttempted && errors.length === 0) {
          try {
            for (const id of ownedIds) expect(await containerExists(id)).toBe(false);
            const volume = await volumeInfo();
            if (volume) {
              if (mountpoint) expect(volume.Mountpoint).toBe(mountpoint);
              if (acceptedVolume !== undefined) expect(volume).toEqual(acceptedVolume);
              const ids = (
                await command(["container", "ls", "-a", "--no-trunc", "--format", "{{.ID}}"])
              ).stdout.trim();
              for (const id of ids === "" ? [] : ids.split("\n")) {
                expect(id).toMatch(/^[a-f0-9]{64}$/);
                const mounts = JSON.parse(
                  (await command(["inspect", "--format", "{{json .Mounts}}", id])).stdout,
                ) as Array<{ Name?: string; Source: string }>;
                expect(
                  mounts.some(
                    (m) =>
                      m.Name === volumeName ||
                      m.Source === volume.Mountpoint ||
                      m.Source.startsWith(`${volume.Mountpoint}/`),
                  ),
                  "volume still referenced; refuse removal",
                ).toBe(false);
              }
              // Revalidate ownership immediately before removal; never remove an unknown volume.
              expect(await volumeInfo()).toEqual(volume);
              await command(["volume", "rm", volumeName]);
              expect(await volumeInfo()).toBeNull();
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, "owned canary cleanup incomplete");
      };
      const fs = async (...args: string[]) => {
        if (!helperId) throw new Error("Linux filesystem helper unavailable");
        return (await command(["exec", helperId, ...args])).stdout;
      };
      const exists = async (path: string) =>
        (await fs(
          "sh",
          "-eu",
          "-c",
          'if [ -e "$1" ] || [ -L "$1" ]; then printf yes; else printf no; fi',
          "canary-fs",
          path,
        )) === "yes";
      const point = async (path: string) => ({
        target: (await fs("readlink", "-f", path)).trim(),
        identity: (await fs("stat", "-L", "-c", "%d:%i", path)).trim(),
      });
      const write = async (path: string, content: string) => {
        await fs("sh", "-eu", "-c", 'printf "%s" "$2" > "$1"', "canary-fs", path, content);
      };
      const text = (path: string) => fs("cat", join(path, "tt.bin"));
      const writes = async (path: string, name: string) =>
        (await text(path)).split("\n").filter((line) => line === `WRITE ${name}`).length;
      const bindSource = (path: string) => {
        if (!mountpoint || !path.startsWith("/fixture/") || path.includes(".."))
          throw new Error("unverified daemon fixture bind source");
        return `${mountpoint}${path.slice("/fixture".length)}`;
      };
      const validateConsumerMounts = async (id: string, name: string, dataPath: string) => {
        if (!mountpoint) throw new Error("daemon fixture mountpoint unverified");
        const mounts = await mountsFor(id);
        const receipt = { id, name, mounts, validated: false };
        mountReceipts.push(receipt);
        expect(mounts).toHaveLength(2);
        for (const [path, destination, writable] of [
          [dataPath, "/data", true],
          [script, "/canary.sh", false],
        ] as const) {
          const matches = mounts.filter((m) => m.Destination === destination);
          expect(matches).toHaveLength(1);
          const mount = matches[0];
          if (!mount) throw new Error("consumer fixture mount missing");
          expect(mount.Type).toBe("bind");
          expect([undefined, ""]).toContain(mount.Name);
          expect(mount.RW).toBe(writable);
          const expected = await point(path);
          // Accept only the requested source or its exact helper-proven canonical target.
          expect([bindSource(path), bindSource(expected.target)]).toContain(mount.Source);
          const actualPath = `/fixture${mount.Source.slice(mountpoint.length)}`;
          expect(await point(actualPath)).toEqual(expected);
        }
        receipt.validated = true;
      };
      const inodeIn = async (id: string) =>
        (await command(["exec", id, "stat", "-c", "%d:%i", "/data/tt.bin"])).stdout.trim();
      const ctx = () => ({ ...context(), signal: AbortSignal.timeout(120_000) });
      const script = "/fixture/owner.sh";
      const writerScript = `#!/bin/sh
name="$1"
exec 3>>/data/tt.bin
trap 'printf "TERM %s\\n" "$name" >&3; sleep 2; printf "EOF %s\\n" "$name" >&3; exit 0' TERM INT
printf "START %s\\n" "$name" >&3
while :; do printf "WRITE %s\\n" "$name" >&3; sleep 0.1; done
`;
      const diagnosticReceipts: unknown[] = [];
      const fileContents = (value: string) => ({
        markers: value.split("\n").filter((line) => line === "PRIOR" || line === "CANDIDATE"),
        primaryWrites: value.split("\n").filter((line) => line === "WRITE motis").length,
        stagingWrites: value.split("\n").filter((line) => line === "WRITE motis-staging").length,
        primaryEof: value.includes("EOF motis\n"),
        stagingEof: value.includes("EOF motis-staging\n"),
      });
      const diagnose = async (phase: string, paths: Record<string, string>) => {
        const hosts = Object.fromEntries(
          await Promise.all(
            Object.entries(paths).map(async ([name, path]) => {
              if (!(await exists(path))) return [name, { path, exists: false }];
              const file = join(path, "tt.bin");
              const alias = (
                await fs(
                  "sh",
                  "-eu",
                  "-c",
                  'if [ -L "$1" ]; then readlink "$1"; fi',
                  "canary-fs",
                  path,
                )
              ).trim();
              return [
                name,
                {
                  path,
                  directory: await point(path),
                  aliasTarget: alias || null,
                  file: (await exists(file))
                    ? { ...(await point(file)), ...fileContents(await fs("cat", file)) }
                    : null,
                },
              ];
            }),
          ),
        );
        const containers = [];
        for (const id of ownedIds) {
          if (id === helperId) continue;
          const listed = (
            await command([
              "container",
              "ls",
              "-a",
              "--no-trunc",
              "--filter",
              `id=${id}`,
              "--format",
              "{{.ID}}",
            ])
          ).stdout.trim();
          if (listed === "") {
            containers.push({ id, absent: true });
            continue;
          }
          expect(listed).toBe(id);
          const state = (
            await command(["inspect", "--format", "{{.State.Status}}:{{.State.Pid}}", id])
          ).stdout.trim();
          if (!state.startsWith("running:")) {
            containers.push({ id, state });
            continue;
          }
          const probe = async (args: string[]) =>
            (await command(["exec", id, ...args])).stdout.trim();
          const content = await probe(["cat", "/data/tt.bin"]);
          containers.push({
            id,
            state,
            dataDirectoryStat: await probe(["stat", "-L", "-c", "%d:%i", "/data"]),
            dataStat: await probe(["stat", "-L", "-c", "%d:%i", "/data/tt.bin"]),
            fd3Stat: await probe(["stat", "-L", "-c", "%d:%i", "/proc/1/fd/3"]),
            fd3Target: await probe(["readlink", "/proc/1/fd/3"]),
            contents: fileContents(content),
          });
        }
        diagnosticReceipts.push({ phase, at: new Date().toISOString(), hosts, containers });
      };
      const evidence: Array<{
        layout: string;
        scenario: string;
        primaryStopped: boolean;
        ownership: boolean;
      }> = [];
      const failures: unknown[] = [];
      const report = (emit: () => void) => {
        try {
          emit();
        } catch (error) {
          failures.push(error);
        }
      };
      try {
        // Data-manager and consumers share a Linux parent filesystem in the supported deployment.
        // This does not cover the observed wrong-object bind on Mac-shared directories.
        expect(
          (await command(["info", "--format", "{{.OSType}}:{{.Architecture}}"])).stdout.trim(),
        ).toMatch(/^linux:(x86_64|aarch64|amd64|arm64)$/);
        for (const name of ["motis", "motis-staging"] as const)
          expect(
            (await command(listing(name))).stdout.trim(),
            `existing ${name}; refuse canary allocation`,
          ).toBe("");
        expect(await volumeInfo()).toBeNull();
        volumeAttempted = true;
        expect(
          (
            await command([
              "volume",
              "create",
              "--label",
              `openmapx.canary.owner=${owner}`,
              volumeName,
            ])
          ).stdout.trim(),
        ).toBe(volumeName);
        const volume = await volumeInfo();
        if (!volume) throw new Error("owned Linux volume unavailable");
        mountpoint = volume.Mountpoint;
        acceptedVolume = volume;
        expect(
          (
            await command([
              "container",
              "ls",
              "-a",
              "--no-trunc",
              "--filter",
              `name=^/${helperName}$`,
              "--format",
              "{{.ID}}",
            ])
          ).stdout.trim(),
        ).toBe("");
        const allocatedHelper = (
          await command([
            "run",
            "-d",
            "--name",
            helperName,
            "--network",
            "none",
            "--label",
            `openmapx.canary.owner=${owner}`,
            "--mount",
            `type=volume,source=${volumeName},target=/fixture`,
            image,
            "sleep",
            "240",
          ])
        ).stdout.trim();
        expect(allocatedHelper).toMatch(/^[a-f0-9]{64}$/);
        expect(
          (
            await command([
              "inspect",
              "--format",
              '{{index .Config.Labels "openmapx.canary.owner"}}',
              allocatedHelper,
            ])
          ).stdout.trim(),
        ).toBe(owner);
        helperId = allocatedHelper;
        ownedIds.add(helperId);
        const helperMounts = await mountsFor(helperId);
        const helperReceipt = {
          id: helperId,
          name: helperName,
          mounts: helperMounts,
          validated: false,
        };
        mountReceipts.push(helperReceipt);
        expect(helperMounts).toHaveLength(1);
        expect(helperMounts[0]).toMatchObject({
          Type: "volume",
          Name: volumeName,
          Source: mountpoint,
          Destination: "/fixture",
          RW: true,
        });
        helperReceipt.validated = true;
        await write(script, writerScript);
        for (const layout of ["rename", "two-slot"] as const) {
          for (const scenario of [
            "promote-and-rollback",
            "absent-staging",
            "failed-staging-stop",
          ] as const) {
            // Name-based operations require exclusive use of these names throughout this local canary.
            for (const name of ["motis", "motis-staging"] as const) {
              expect(
                (await command(listing(name))).stdout.trim(),
                `existing ${name}; refuse canary allocation`,
              ).toBe("");
            }
            const base = join("/fixture", `${layout}-${scenario}`);
            const live = join(base, "live");
            const staging = join(base, "staging");
            if (layout === "two-slot") {
              await fs("mkdir", "-p", join(base, "slots", "A"));
              await fs("mkdir", "-p", join(base, "slots", "B"));
              await fs("ln", "-s", "slots/A", live);
              await fs("ln", "-s", "slots/B", staging);
            } else {
              await fs("mkdir", "-p", live);
              await fs("mkdir", staging);
            }
            await write(join(live, "tt.bin"), "PRIOR\n");
            await write(join(staging, "tt.bin"), "CANDIDATE\n");
            const previous = await point(live);
            const candidate = await point(staging);
            const infra = join(root, `${layout}-${scenario}-infra`);
            mkdirSync(infra);
            const compose = join(infra, "compose.yml");
            const release = join(infra, "release.yml");
            writeFileSync(join(infra, ".env"), "");
            writeFileSync(release, "services: {}\n");
            const service = (name: string, path: string) => `  ${name}:
    image: ${image}
    container_name: ${name}
    network_mode: none
    labels:
      openmapx.canary.owner: ${JSON.stringify(owner)}
    volumes:
      - type: bind
        source: ${JSON.stringify(bindSource(path))}
        target: /data
        bind: { create_host_path: false }
      - type: bind
        source: ${JSON.stringify(bindSource(script))}
        target: /canary.sh
        read_only: true
        bind: { create_host_path: false }
    entrypoint: ["/bin/sh", "/canary.sh", "${name}"]
`;
            writeFileSync(
              compose,
              `name: omx-canary-${randomUUID()}\nservices:\n${service("motis", live)}${service("motis-staging", staging)}`,
            );
            const prefix = [
              "compose",
              "--env-file",
              join(infra, ".env"),
              "-f",
              compose,
              "-f",
              release,
            ];
            await command([...prefix, "up", "-d", "--no-deps", "motis", "motis-staging"]);
            const primaryId = await remember("motis", live);
            const stagingId = await remember("motis-staging", staging);
            const oldInode = await inodeIn(primaryId);
            const newInode = await inodeIn(stagingId);
            expect(oldInode).not.toBe(newInode);
            // The daemon-derived source must resolve to the helper's actual Linux object.
            expect(oldInode).toBe((await point(join(live, "tt.bin"))).identity);
            expect(newInode).toBe((await point(join(staging, "tt.bin"))).identity);
            await vi.waitFor(
              async () => {
                expect(await writes(live, "motis")).toBeGreaterThan(0);
                expect(await writes(staging, "motis-staging")).toBeGreaterThan(0);
              },
              { timeout: 5_000 },
            );
            const runtime = createDockerRuntime({
              stack: { infraDir: infra, composePath: compose, composeReleasePath: release },
              fileExists: existsSync,
            });
            const diagnosticPaths = { live, staging, previous: `${live}.previous` };
            await diagnose(`${layout}/${scenario}/before-primary-stop`, diagnosticPaths);
            const started = Date.now();
            await expect(
              dispatchOpsOperation(runtime, { kind: "motis.primary.stop" }, ctx()),
            ).resolves.toEqual({ changed: true, state: "stopped" });
            const stopElapsedMs = Date.now() - started;
            expect(stopElapsedMs).toBeGreaterThanOrEqual(1_800);
            await diagnose(`${layout}/${scenario}/after-primary-stop`, diagnosticPaths);
            expect(await text(live)).toContain("EOF motis\n");
            expect(
              (await command(["inspect", "--format", "{{.State.Pid}}", primaryId])).stdout.trim(),
            ).toBe("0");
            if (scenario === "failed-staging-stop") {
              const failing = createDockerRuntime({
                stack: { infraDir: infra, composePath: compose, composeReleasePath: release },
                fileExists: existsSync,
                execFile: async (file, args, options) => {
                  if (args[0] === "stop" && args[1] === "motis-staging")
                    throw new Error("injected staging stop failure");
                  return runContainedProcess(file, args, options);
                },
              });
              await expect(
                dispatchOpsOperation(failing, { kind: "motis.staging.stop" }, ctx()),
              ).rejects.toThrow("injected staging stop failure");
              expect(await point(live)).toEqual(previous);
              expect(await point(staging)).toEqual(candidate);
              await dispatchOpsOperation(runtime, { kind: "motis.primary.restart" }, ctx());
              await vi.waitFor(
                async () => expect((await text(live)).split("START motis\n")).toHaveLength(3),
                {
                  timeout: 5_000,
                },
              );
              expect(await inodeIn(primaryId)).toBe(oldInode);
              expect(await text(live)).not.toContain("WRITE motis-staging\n");
              expect(await text(staging)).not.toContain("WRITE motis\n");
            } else {
              await diagnose(`${layout}/${scenario}/before-staging-stop`, diagnosticPaths);
              await expect(
                dispatchOpsOperation(runtime, { kind: "motis.staging.stop" }, ctx()),
              ).resolves.toEqual({ changed: true, state: "stopped" });
              await diagnose(`${layout}/${scenario}/after-staging-stop`, diagnosticPaths);
              expect(await text(staging)).toContain("EOF motis-staging\n");
              if (scenario === "absent-staging") {
                await command(["rm", stagingId]);
                await expect(
                  dispatchOpsOperation(runtime, { kind: "motis.staging.stop" }, ctx()),
                ).resolves.toEqual({ changed: false, state: "absent" });
              }
              const priorWrites = await writes(live, "motis");
              const candidateWrites = await writes(staging, "motis-staging");
              const flip = async (active: "A" | "B") => {
                for (const [alias, target] of [
                  [live, active],
                  [staging, active === "A" ? "B" : "A"],
                ] as const) {
                  const temporary = `${alias}.canary-tmp`;
                  await fs("ln", "-s", `slots/${target}`, temporary);
                  await fs("mv", "-T", temporary, alias);
                }
              };
              if (layout === "two-slot") await flip("B");
              else {
                await fs("mv", "-T", live, `${live}.previous`);
                await fs("mv", "-T", staging, live);
                await fs("mkdir", staging);
              }
              await diagnose(`${layout}/${scenario}/before-promotion-after-swap`, diagnosticPaths);
              await dispatchOpsOperation(
                runtime,
                { kind: "motis.primary.promote", preparedRunId: "canary-candidate" },
                ctx(),
              );
              const promotedId = await remember("motis", live);
              expect(await inodeIn(promotedId)).toBe(newInode);
              await vi.waitFor(async () => expect(await writes(live, "motis")).toBeGreaterThan(0), {
                timeout: 5_000,
              });
              expect(await writes(live, "motis-staging")).toBe(candidateWrites);
              expect(await text(live)).toContain("CANDIDATE\n");
              const oldPath = layout === "two-slot" ? join(base, "slots", "A") : `${live}.previous`;
              expect(await writes(oldPath, "motis")).toBe(priorWrites);
              expect(await text(oldPath)).toContain("PRIOR\n");
              await diagnose(`${layout}/${scenario}/after-promotion`, diagnosticPaths);
              if (scenario === "promote-and-rollback") {
                await diagnose(`${layout}/${scenario}/before-rollback-stop`, diagnosticPaths);
                await dispatchOpsOperation(runtime, { kind: "motis.primary.stop" }, ctx());
                await diagnose(`${layout}/${scenario}/after-rollback-stop`, diagnosticPaths);
                if (layout === "two-slot") await flip("A");
                else {
                  await fs("rmdir", staging);
                  await fs("mv", "-T", live, staging);
                  await fs("mv", "-T", `${live}.previous`, live);
                }
                await diagnose(
                  `${layout}/${scenario}/before-rollback-promotion-after-swap`,
                  diagnosticPaths,
                );
                const stoppedCandidateWrites = await writes(staging, "motis");
                await dispatchOpsOperation(
                  runtime,
                  { kind: "motis.primary.promote", preparedRunId: "canary-rollback" },
                  ctx(),
                );
                const restoredId = await remember("motis", live);
                await vi.waitFor(
                  async () =>
                    expect(
                      (
                        await command([
                          "exec",
                          restoredId,
                          "stat",
                          "-L",
                          "-c",
                          "%d:%i",
                          "/proc/1/fd/3",
                        ])
                      ).stdout.trim(),
                    ).toMatch(/^\d+:\d+$/),
                  { timeout: 5_000 },
                );
                await diagnose(`${layout}/${scenario}/after-rollback-promotion`, diagnosticPaths);
                expect(await inodeIn(restoredId)).toBe(oldInode);
                expect(await text(live)).toContain("PRIOR\n");
                expect(await text(staging)).toContain("CANDIDATE\n");
                expect(await point(live)).toEqual(previous);
                expect(await point(staging)).toEqual(candidate);
                await vi.waitFor(
                  async () => expect(await writes(live, "motis")).toBeGreaterThan(priorWrites),
                  { timeout: 5_000 },
                );
                expect(await writes(staging, "motis")).toBe(stoppedCandidateWrites);
              }
            }
            evidence.push({ layout, scenario, primaryStopped: true, ownership: true });
            await cleanup();
          }
        }
        expect(evidence).toHaveLength(6);
        for (const id of ownedIds) {
          if (id === helperId) continue;
          expect(
            (
              await command([
                "container",
                "ls",
                "-a",
                "--no-trunc",
                "--filter",
                `id=${id}`,
                "--format",
                "{{.ID}}",
              ])
            ).stdout.trim(),
          ).toBe("");
        }
        const imageId = (
          await command(["image", "inspect", "--format", "{{.Id}}", image])
        ).stdout.trim();
        expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
        console.info(
          "MOTIS stop canary",
          JSON.stringify({
            image,
            imageId,
            owner,
            ownedConsumerContainerIds: [...ownedIds].filter((id) => id !== helperId),
            ownedConsumersAbsent: true,
            filesystem: "Owned Linux local-volume parent with ordinary child bind mounts",
            volumeName,
            mountpoint,
            helperId,
            assumption: "Serialized local execution with exclusive use of motis and motis-staging",
            stopEvidence: "Primary stop confirmation before subsequent restart or promotion",
            evidence,
          }),
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          report(() =>
            console.info(
              "MOTIS stop canary diagnostic",
              JSON.stringify({
                owner,
                ownedContainerIds: [...ownedIds],
                acceptedVolume,
                mountReceipts,
                diagnosticReceipts,
              }),
            ),
          );
        } finally {
          try {
            await cleanup(true);
            report(() =>
              console.info(
                "MOTIS stop canary diagnostic cleanup",
                JSON.stringify({
                  owner,
                  ownedContainerIds: [...ownedIds],
                  ownedContainersAbsent: true,
                  volumeName,
                  volumeAttempted,
                  ownedVolumeAbsent: volumeAttempted ? true : null,
                }),
              ),
            );
          } catch (cleanupError) {
            failures.push(cleanupError);
            report(() => console.error("MOTIS stop canary cleanup failure", cleanupError));
          } finally {
            try {
              rmSync(root, { recursive: true, force: true });
            } catch (error) {
              failures.push(error);
            }
          }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "canary failed with cleanup errors");
    },
    240_000,
  );

  it.each([
    { kind: "stack.start" },
    { kind: "service.start", serviceId: "postgis" },
    { kind: "service.stop", serviceId: "postgis" },
    { kind: "service.restart", serviceId: "postgis" },
    { kind: "service.recreate", serviceId: "postgis" },
    { kind: "service.recreateIsolated", serviceId: "postgis" },
    { kind: "service.remove", serviceId: "postgis" },
  ] satisfies OpsOperation[])("allows the built-in shutdown grace for $kind", async (operation) => {
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async (_file, _args, options) => {
        expect(options.timeout).toBe(600_000);
        expect(options.signal.aborted).toBe(false);
        return { stdout: "", stderr: "" };
      },
    });
    await expect(dispatchOpsOperation(runtime, operation, context())).resolves.toEqual({
      changed: true,
    });
  });

  it.each([
    [{ kind: "docker.status" }, 5_000],
    [{ kind: "stack.status" }, 120_000],
    [{ kind: "service.logs", serviceId: "postgis", tail: 10 }, 120_000],
    [{ kind: "service.pull", serviceId: "postgis" }, 600_000],
  ] satisfies [OpsOperation, number][])(
    "preserves the execution budget for %j",
    async (operation, timeout) => {
      const runtime = createDockerRuntime({
        stack: {
          infraDir: "/trusted",
          composePath: "/trusted/compose.yml",
          composeReleasePath: "/trusted/release.yml",
        },
        fileExists: () => false,
        execFile: async (_file, _args, options) => {
          expect(options.timeout).toBe(timeout);
          return { stdout: "", stderr: "" };
        },
      });
      await dispatchOpsOperation(runtime, operation, context());
    },
  );

  it("terminates aggregate recreation work exactly at the whole-command deadline", async () => {
    vi.useFakeTimers();
    const completed: number[] = [];
    let terminated = false;
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: (_file, _args, options) =>
        new Promise((resolve, reject) => {
          const deadline = setTimeout(() => {
            terminated = true;
            for (const timer of steps) clearTimeout(timer);
            reject(new Error("Contained process failed"));
          }, options.timeout);
          const steps = [300_000, 600_001].map((delay) =>
            setTimeout(() => {
              completed.push(delay);
              if (delay === 600_001) {
                clearTimeout(deadline);
                resolve({ stdout: "", stderr: "" });
              }
            }, delay),
          );
        }),
    });
    try {
      const result = dispatchOpsOperation(
        runtime,
        { kind: "service.recreate", serviceId: "postgis" },
        context(),
      );
      const rejected = expect(result).rejects.toThrow("Contained process failed");
      await vi.advanceTimersByTimeAsync(599_999);
      expect(completed).toEqual([300_000]);
      expect(terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(terminated).toBe(true);
      expect(completed).toEqual([300_000]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("maps lifecycle effects to fixed Compose argv without accepting caller argv or paths", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/stack",
        composePath: "/stack/state/ops-agent/configuration/current/docker-compose.generated.yml",
        composeReleasePath: "/stack/docker-compose.release.yml",
      },
      fileExists: () => true,
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    await dispatchOpsOperation(
      runtime,
      { kind: "service.recreate", serviceId: "motis" },
      context(),
    );
    await dispatchOpsOperation(
      runtime,
      { kind: "service.recreateIsolated", serviceId: "motis" },
      context(),
    );
    const stack = [
      "compose",
      "--env-file",
      "/stack/.env",
      "-f",
      "/stack/state/ops-agent/configuration/current/docker-compose.generated.yml",
      "-f",
      "/stack/docker-compose.release.yml",
    ];
    expect(calls).toEqual([
      { file: "docker", args: [...stack, "up", "-d", "--force-recreate", "motis"] },
      { file: "docker", args: [...stack, "up", "-d", "--force-recreate", "--no-deps", "motis"] },
    ]);
  });

  it("uses fixed container identities for MOTIS effects", async () => {
    const calls: string[][] = [];
    let listings = 0;
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async (_file, args) => {
        calls.push([...args]);
        return {
          stdout:
            args[0] === "container" ? `motis\t${++listings === 1 ? "running" : "exited"}\n` : "",
          stderr: "",
        };
      },
    });
    await dispatchOpsOperation(runtime, { kind: "motis.staging.restart" }, context());
    await dispatchOpsOperation(runtime, { kind: "motis.primary.stop" }, context());
    expect(calls).toEqual([
      ["restart", "motis-staging"],
      ["container", "ls", "-a", "--filter", "name=^/motis$", "--format", "{{.Names}}\t{{.State}}"],
      ["stop", "motis"],
      ["container", "ls", "-a", "--filter", "name=^/motis$", "--format", "{{.Names}}\t{{.State}}"],
    ]);
  });

  describe.each([
    ["motis.primary.stop", "motis"],
    ["motis.staging.stop", "motis-staging"],
  ] as const)("%s confirmed stop", (kind, name) => {
    const listing = [
      "container",
      "ls",
      "-a",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.Names}}\t{{.State}}",
    ];
    const runtimeWith = (
      execFile: NonNullable<Parameters<typeof createDockerRuntime>[0]["execFile"]>,
    ) =>
      createDockerRuntime({
        stack: {
          infraDir: "/trusted",
          composePath: "/trusted/compose.yml",
          composeReleasePath: "/trusted/release.yml",
        },
        fileExists: () => false,
        execFile,
      });

    it("confirms a running container has stopped with a bounded post-stop listing", async () => {
      const ctx = context();
      const calls: string[][] = [];
      let listings = 0;
      const runtime = runtimeWith(async (file, args, options) => {
        expect(file).toBe("docker");
        expect(options.signal).toBe(ctx.signal);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(120_000);
        expect(options.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
        calls.push([...args]);
        return {
          stdout:
            args[0] === "container" ? `${name}\t${++listings === 1 ? "running" : "exited"}\n` : "",
          stderr: "",
        };
      });
      await expect(dispatchOpsOperation(runtime, { kind }, ctx)).resolves.toEqual({
        changed: true,
        state: "stopped",
      });
      expect(calls).toEqual([listing, ["stop", name], listing]);
    });

    it.each(["created", "exited", "dead"])(
      "accepts an already %s container without invoking stop",
      async (state) => {
        const calls: string[][] = [];
        const runtime = runtimeWith(async (_file, args) => {
          calls.push([...args]);
          return { stdout: `${name}\t${state}\n`, stderr: "" };
        });
        await expect(dispatchOpsOperation(runtime, { kind }, context())).resolves.toEqual({
          changed: false,
          state: "stopped",
        });
        expect(calls).toEqual([listing]);
      },
    );

    it("proves absence through a successful exact-name listing", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "" };
      });
      await expect(dispatchOpsOperation(runtime, { kind }, context())).resolves.toEqual({
        changed: false,
        state: "absent",
      });
      expect(calls).toEqual([listing]);
    });

    it.each([
      `${name}-other\texited\n`,
      `${name}\texited\n${name}\texited\n`,
      `${name}\tpaused\n`,
      `${name}\trestarting\n`,
      `${name}\tremoving\n`,
      `${name}\tunknown\n`,
      `${name}\n`,
    ])("rejects ambiguous or unsafe listing %j before stop", async (stdout) => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        return { stdout, stderr: "" };
      });
      await expect(dispatchOpsOperation(runtime, { kind }, context())).rejects.toThrow();
      expect(calls).toEqual([listing]);
    });

    it.each(["timed out", "permission denied", "daemon unreachable"])(
      "does not classify %s as absence",
      async (message) => {
        const runtime = runtimeWith(async () => {
          throw new Error(message);
        });
        await expect(dispatchOpsOperation(runtime, { kind }, context())).rejects.toThrow(message);
      },
    );

    it.each(["running", "paused", "restarting", "removing"])(
      "rejects a still %s container after stop exits successfully",
      async (state) => {
        let listings = 0;
        const runtime = runtimeWith(async (_file, args) => ({
          stdout:
            args[0] === "container" ? `${name}\t${++listings === 1 ? "running" : state}\n` : "",
          stderr: "",
        }));
        await expect(dispatchOpsOperation(runtime, { kind }, context())).rejects.toThrow();
        expect(listings).toBe(2);
      },
    );

    it("retains uncertainty when post-stop inspection fails", async () => {
      let listings = 0;
      const runtime = runtimeWith(async (_file, args) => {
        if (args[0] === "container" && ++listings === 2) throw new Error("confirmation timed out");
        return { stdout: args[0] === "container" ? `${name}\trunning\n` : "", stderr: "" };
      });
      await expect(dispatchOpsOperation(runtime, { kind }, context())).rejects.toThrow(
        "confirmation timed out",
      );
    });

    it("waits for slow stop completion before checking state", async () => {
      let releaseStop!: () => void;
      const stop = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let listings = 0;
      const runtime = runtimeWith(async (_file, args) => {
        if (args[0] === "stop") await stop;
        return {
          stdout:
            args[0] === "container" ? `${name}\t${++listings === 1 ? "running" : "exited"}\n` : "",
          stderr: "",
        };
      });
      const result = dispatchOpsOperation(runtime, { kind }, context());
      await vi.waitFor(() => expect(listings).toBe(1));
      releaseStop();
      await expect(result).resolves.toEqual({ changed: true, state: "stopped" });
      expect(listings).toBe(2);
    });
  });

  it("owns the container and path for data-manager capacity and feed-proxy effects", async () => {
    const calls: string[][] = [];
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async (_file, args) => {
        calls.push([...args]);
        return {
          stdout:
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
            "/dev/vdb 100000 20000 80000 20% /var/lib/postgresql",
          stderr: "",
        };
      },
    });

    await expect(
      dispatchOpsOperation(runtime, { kind: "postgis.capacity.inspect" }, context()),
    ).resolves.toEqual({ availableBytes: 81_920_000 });
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "feedProxy.validateAndReload", candidateId: "feedproxy-1" },
        context(),
      ),
    ).resolves.toEqual({ candidateId: "feedproxy-1", reloaded: true });

    // The caller supplied neither a container nor a path, and the proxy is
    // validated before it is reloaded.
    expect(calls).toEqual([
      ["exec", "postgis", "df", "-Pk", "/var/lib/postgresql"],
      ["exec", "motis-feed-proxy", "nginx", "-t"],
      ["exec", "motis-feed-proxy", "nginx", "-s", "reload"],
    ]);
  });

  describe("Valhalla traffic effects", () => {
    const CHOWN_ID = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const runtimeWith = (
      execFile: (
        file: string,
        args: readonly string[],
        options: { timeout: number },
      ) => Promise<unknown>,
    ) =>
      createDockerRuntime({
        stack: {
          infraDir: "/trusted",
          composePath: "/trusted/compose.yml",
          composeReleasePath: "/trusted/release.yml",
        },
        fileExists: () => false,
        execFile: execFile as never,
      });

    it("runs graph maintenance behind a durable fence while Valhalla is stopped", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-maintenance-"));
      const calls: string[][] = [];
      const generation = "a".repeat(64);
      try {
        const runtime = createDockerRuntime({
          stack: {
            infraDir: "/trusted",
            composePath: "/trusted/compose.yml",
            composeReleasePath: "/trusted/release.yml",
          },
          fileExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) => {
            calls.push([...args]);
            if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
              return { stdout: "false\n", stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.Image}}")) {
              return { stdout: `sha256:${"c".repeat(64)}\n`, stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.State.Health.Status}}")) {
              return { stdout: "healthy\n", stderr: "" };
            }
            if (args[0] === "run") {
              return { stdout: `OPENMAPX_GRAPH_GENERATION=${generation}\n`, stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
        });

        await expect(
          dispatchOpsOperation(
            runtime,
            {
              kind: "valhalla.traffic.maintain",
              plan: "apply-predicted-and-rebuild",
              preparedGeneration: "11111111-1111-4111-8111-111111111111",
            },
            context(),
          ),
        ).resolves.toEqual({
          changed: true,
          graphGeneration: generation,
          extractGeneration: generation,
          waysToEdgesGeneration: generation,
        });

        expect(calls.map((call) => call[0])).toEqual([
          "stop",
          "inspect",
          "inspect",
          "run",
          "start",
          "inspect",
        ]);
        expect(calls[3]).toEqual(
          expect.arrayContaining([
            "--volumes-from",
            "docker-valhalla-1",
            `sha256:${"c".repeat(64)}`,
          ]),
        );
        expect(calls[3]?.join(" ")).toContain(
          "valhalla_add_predicted_traffic -c /custom_files/valhalla.json /custom_files/predicted-csv/11111111-1111-4111-8111-111111111111",
        );
        expect(calls[3]?.join(" ")).toContain("valhalla_build_extract");
        expect(calls[3]?.join(" ")).toContain("valhalla_ways_to_edges");
        expect(existsSync(join(dataRoot, "valhalla", "osm-pbf", ".traffic-maintenance.json"))).toBe(
          false,
        );
        expect(
          JSON.parse(
            readFileSync(join(dataRoot, "valhalla", "osm-pbf", "traffic-generations.json"), "utf8"),
          ),
        ).toMatchObject({
          schemaVersion: 1,
          graphGeneration: generation,
          extractGeneration: generation,
          waysToEdgesGeneration: generation,
        });
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it.each(["descriptor", "path"] as const)(
      "never follows a symlink data-manager planted beside the generations manifest (%s)",
      async (mode) => {
        if (mode === "descriptor" && process.platform !== "linux") return;
        const root = mkdtempSync(join(tmpdir(), "valhalla-maintenance-planted-"));
        const dataRoot = join(root, "data");
        const shared = join(dataRoot, "valhalla", "osm-pbf");
        mkdirSync(shared, { recursive: true });
        const sentinel = join(root, "sentinel");
        writeFileSync(sentinel, "untouched");
        // The temporary name the agent used to write, and the manifest itself.
        symlinkSync(sentinel, join(shared, `traffic-generations.json.${"f".repeat(64)}.tmp`));
        symlinkSync(sentinel, join(shared, "traffic-generations.json"));
        const generation = "a".repeat(64);
        try {
          const runtime = createDockerRuntime({
            stack: {
              infraDir: "/trusted",
              composePath: "/trusted/compose.yml",
              composeReleasePath: "/trusted/release.yml",
            },
            fileExists: () => false,
            trafficDataRoot: dataRoot,
            descriptorAnchorRoot: mode === "descriptor" ? "/proc/self/fd" : null,
            execFile: async (_file, args) => {
              if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
                return { stdout: "false\n", stderr: "" };
              }
              if (args[0] === "inspect" && args.includes("{{.Image}}")) {
                return { stdout: `sha256:${"c".repeat(64)}\n`, stderr: "" };
              }
              if (args[0] === "inspect" && args.includes("{{.State.Health.Status}}")) {
                return { stdout: "healthy\n", stderr: "" };
              }
              if (args[0] === "run") {
                return { stdout: `OPENMAPX_GRAPH_GENERATION=${generation}\n`, stderr: "" };
              }
              return { stdout: "", stderr: "" };
            },
          });
          await expect(
            dispatchOpsOperation(
              runtime,
              { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" },
              context(),
            ),
          ).resolves.toMatchObject({ changed: true, graphGeneration: generation });
          expect(readFileSync(sentinel, "utf8")).toBe("untouched");
          expect(lstatSync(join(shared, "traffic-generations.json")).isFile()).toBe(true);
          expect(
            JSON.parse(readFileSync(join(shared, "traffic-generations.json"), "utf8")),
          ).toMatchObject({ graphGeneration: generation });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it("refuses to maintain through a data directory replaced by a symlink", async () => {
      const root = mkdtempSync(join(tmpdir(), "valhalla-maintenance-swapped-"));
      const dataRoot = join(root, "data");
      const outside = join(root, "outside");
      mkdirSync(join(outside, "osm-pbf"), { recursive: true });
      mkdirSync(dataRoot);
      symlinkSync(outside, join(dataRoot, "valhalla"));
      try {
        const runtime = createDockerRuntime({
          stack: {
            infraDir: "/trusted",
            composePath: "/trusted/compose.yml",
            composeReleasePath: "/trusted/release.yml",
          },
          fileExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) =>
            args[0] === "inspect" && args.includes("{{.State.Running}}")
              ? { stdout: "false\n", stderr: "" }
              : { stdout: "", stderr: "" },
        });
        await expect(
          dispatchOpsOperation(
            runtime,
            { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" },
            context(),
          ),
        ).rejects.toThrow();
        expect(readdirSync(join(outside, "osm-pbf"))).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("leaves serving stopped and the durable fence present when maintenance fails", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-maintenance-fail-"));
      const calls: string[][] = [];
      try {
        const runtime = createDockerRuntime({
          stack: {
            infraDir: "/trusted",
            composePath: "/trusted/compose.yml",
            composeReleasePath: "/trusted/release.yml",
          },
          fileExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) => {
            calls.push([...args]);
            if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
              return { stdout: "false\n", stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.Image}}")) {
              return { stdout: `sha256:${"d".repeat(64)}\n`, stderr: "" };
            }
            if (args[0] === "run") throw new Error("build failed");
            return { stdout: "", stderr: "" };
          },
        });

        await expect(
          dispatchOpsOperation(
            runtime,
            { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" },
            context(),
          ),
        ).rejects.toThrow();

        expect(calls.some((call) => call[0] === "start")).toBe(false);
        expect(calls.some((call) => call[0] === "rm" && call[1] === "-f")).toBe(true);
        expect(calls.at(-1)).toEqual([
          "inspect",
          "--format",
          "{{.State.Running}}",
          "docker-valhalla-1",
        ]);
        expect(existsSync(join(dataRoot, "valhalla", "osm-pbf", ".traffic-maintenance.json"))).toBe(
          true,
        );
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it("fails closed when compensation cannot prove the maintenance worker stopped", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-maintenance-worker-fail-"));
      const maintenanceContainer = `openmapx-valhalla-maint-${"f".repeat(16)}`;
      try {
        const runtime = createDockerRuntime({
          stack: {
            infraDir: "/trusted",
            composePath: "/trusted/compose.yml",
            composeReleasePath: "/trusted/release.yml",
          },
          fileExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) => {
            if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
              return { stdout: "false\n", stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.Image}}")) {
              return { stdout: `sha256:${"d".repeat(64)}\n`, stderr: "" };
            }
            if (args[0] === "run") throw new Error("build failed");
            if (args[0] === "rm") throw new Error("docker daemon unavailable");
            if (args[0] === "ps") {
              return { stdout: `${maintenanceContainer}\n`, stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
        });

        await expect(
          dispatchOpsOperation(
            runtime,
            { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" },
            context(),
          ),
        ).rejects.toThrow("maintenance worker could not be terminated");
        expect(existsSync(join(dataRoot, "valhalla", "osm-pbf", ".traffic-maintenance.json"))).toBe(
          true,
        );
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it("fences Valhalla serving when traffic cannot be cleared", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        return { stdout: args[0] === "inspect" ? "false\n" : "", stderr: "" };
      });
      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.disable" }, context()),
      ).resolves.toEqual({ changed: true });
      expect(calls).toEqual([
        ["stop", "--time", "1", "docker-valhalla-1"],
        ["inspect", "--format", "{{.State.Running}}", "docker-valhalla-1"],
      ]);
    });

    it("reports readiness from the tile and extract timestamps", async () => {
      const inspect = async (tile: string | null, tar: string | null) => {
        const runtime = runtimeWith(async (_file, args) => {
          const path = args.at(-1);
          const value = path === "/custom_files/valhalla_tiles" ? tile : tar;
          if (value === null) throw new Error("stat failed");
          return { stdout: `${value}\n`, stderr: "" };
        });
        return dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context());
      };

      // No extract at all.
      await expect(inspect("200", null)).resolves.toEqual({ state: "not_ready" });
      // Tiles newer than the extract.
      await expect(inspect("300", "200")).resolves.toEqual({ state: "not_ready" });
      // Extract newer than the tiles.
      await expect(inspect("100", "200")).resolves.toEqual({ state: "ready" });
      // Unreadable tile directory with an extract present is inconclusive, not
      // a rebuild trigger.
      await expect(inspect(null, "200")).resolves.toEqual({ state: "unknown" });
    });

    it("requires a coherent maintenance generation manifest before reporting ready", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-generation-inspect-"));
      const sharedDir = join(dataRoot, "valhalla", "osm-pbf");
      mkdirSync(sharedDir, { recursive: true });
      const runtime = createDockerRuntime({
        stack: {
          infraDir: "/trusted",
          composePath: "/trusted/compose.yml",
          composeReleasePath: "/trusted/release.yml",
        },
        fileExists: () => false,
        trafficDataRoot: dataRoot,
        execFile: async (_file, args) => ({
          stdout:
            args[0] === "exec"
              ? args.at(-1) === "/custom_files/traffic.tar"
                ? "200\n"
                : "100\n"
              : "",
          stderr: "",
        }),
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context()),
      ).resolves.toEqual({ state: "not_ready" });

      const generation = "b".repeat(64);
      writeFileSync(
        join(sharedDir, "traffic-generations.json"),
        JSON.stringify({
          schemaVersion: 1,
          graphGeneration: generation,
          extractGeneration: generation,
          waysToEdgesGeneration: generation,
          completedAt: new Date().toISOString(),
        }),
      );
      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context()),
      ).resolves.toEqual({ state: "ready" });

      rmSync(dataRoot, { recursive: true, force: true });
    });

    it("reports a manifest the watchdog is re-checking as inconclusive, not as a rebuild", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-generation-unverified-"));
      const sharedDir = join(dataRoot, "valhalla", "osm-pbf");
      mkdirSync(sharedDir, { recursive: true });
      const calls: string[][] = [];
      const runtime = createDockerRuntime({
        stack: {
          infraDir: "/trusted",
          composePath: "/trusted/compose.yml",
          composeReleasePath: "/trusted/release.yml",
        },
        fileExists: () => false,
        trafficDataRoot: dataRoot,
        execFile: async (_file, args) => {
          calls.push([...args]);
          return { stdout: "100\n", stderr: "" };
        },
      });
      writeFileSync(join(sharedDir, "traffic-generations.unverified.json"), "{}");

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context()),
      ).resolves.toEqual({ state: "unknown" });
      expect(calls).toEqual([]);

      rmSync(dataRoot, { recursive: true, force: true });
    });

    it("produces way_edges.txt on the shared mount and hands it to the data owner", async () => {
      const calls: string[][] = [];
      const timeouts: number[] = [];
      const runtime = runtimeWith(async (_file, args, options) => {
        calls.push([...args]);
        timeouts.push(options.timeout);
        return { stdout: "", stderr: "" };
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.refreshWaysToEdges" }, context()),
      ).resolves.toEqual({ changed: true });

      // A whole-country graph already takes minutes; the operation's own bound applies.
      expect(timeouts[0]).toBe(30 * 60_000);
      expect(calls).toEqual([
        [
          "exec",
          "docker-valhalla-1",
          "valhalla_ways_to_edges",
          "-c",
          "/custom_files/valhalla.json",
        ],
        [
          "exec",
          "docker-valhalla-1",
          "chown",
          CHOWN_ID,
          "/custom_files/valhalla_tiles/way_edges.txt",
        ],
      ]);
    });
  });

  it("fails closed for complex typed effects that later migration slices must wire", async () => {
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async () => ({ stdout: "", stderr: "" }),
    });
    await expect(
      dispatchOpsOperation(
        runtime,
        { expectedCurrentRevisionId: null, kind: "stack.render", revisionId: "revision_1" },
        context(),
      ),
    ).rejects.toMatchObject({
      name: "OpsNotWiredError",
    });
    await expect(
      dispatchOpsOperation(runtime, { kind: "stack.stop" }, context()),
    ).rejects.toMatchObject({ name: "OpsNotWiredError" });
    await expect(
      dispatchOpsOperation(runtime, { kind: "service.update", serviceId: "app-api" }, context()),
    ).rejects.toMatchObject({ name: "OpsNotWiredError" });
  });

  describe("stack.status", () => {
    const stackStatus = (stdout: string) =>
      dispatchOpsOperation(
        createDockerRuntime({
          stack: {
            infraDir: "/trusted",
            composePath: "/trusted/compose.yml",
            composeReleasePath: "/trusted/release.yml",
          },
          fileExists: () => false,
          execFile: async (_file, args) => {
            expect(args).toEqual([
              "compose",
              "-f",
              "/trusted/compose.yml",
              "ps",
              "--format",
              "json",
            ]);
            return { stdout, stderr: "" };
          },
        }),
        { kind: "stack.status" },
        context(),
      );
    // Real `docker compose ps --format json` output; see the README beside it.
    const captured = (name: string) =>
      readFileSync(
        new URL(
          `../../../packages/core/src/services/__tests__/__fixtures__/compose-ps/${name}`,
          import.meta.url,
        ),
        "utf8",
      );

    it.each([["compose-5.6.1.stdout"], ["compose-2.21.0.stdout"], ["compose-2.20.3.stdout"]])(
      "reports every service in %s",
      async (name) => {
        await expect(stackStatus(captured(name))).resolves.toEqual({
          services: [
            { serviceId: "crashloop", state: "restarting" },
            { serviceId: "web", state: "running" },
            { serviceId: "worker", state: "paused" },
          ],
        });
      },
    );

    it.each([["compose-5.6.1-empty.stdout"], ["compose-2.20.3-empty.stdout"]])(
      "reports no services for the empty stack in %s",
      async (name) => {
        await expect(stackStatus(captured(name))).resolves.toEqual({ services: [] });
      },
    );

    it("keeps the first 256 services", async () => {
      const lines = Array.from(
        { length: 300 },
        (_, index) => `{"Service":"service-${index}","State":"running"}`,
      );
      const result = await stackStatus(`${lines.join("\n")}\n`);
      expect(result.services).toHaveLength(256);
      expect(result.services.at(-1)).toEqual({ serviceId: "service-255", state: "running" });
    });

    it.each([
      ['{"Service":"web","State":"running"}\nnot json\n'],
      ['[\n  {"Service":"web","State":"running"}\n]\n'],
      ['"web"\n'],
    ])("refuses output that is not Compose's: %j", async (stdout) => {
      await expect(stackStatus(stdout)).rejects.toThrow("Contained process failed");
    });
  });

  it("inspects only the fixed Dawarich services and provisioning marker", async () => {
    const calls: string[][] = [];
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async (_file, args) => {
        calls.push([...args]);
        if (args.includes("ps")) {
          // One object per line, as Compose 2.21 and later print it.
          return {
            stdout: [
              { Service: "dawarich-app", State: "running" },
              { Service: "dawarich-sidekiq", State: "running" },
              { Service: "dawarich-postgis", State: "running" },
              { Service: "dawarich-redis", State: "running" },
            ]
              .map((entry) => `${JSON.stringify(entry)}\n`)
              .join(""),
            stderr: "",
          };
        }
        return {
          stdout: args.includes("dawarich-app")
            ? "0123456789abcdef0123456789abcdef\n"
            : "fedcba9876543210fedcba9876543210\n",
          stderr: "",
        };
      },
    });

    await expect(
      dispatchOpsOperation(runtime, { kind: "dawarich.provisioning.inspect" }, context()),
    ).resolves.toEqual({
      services: [
        { serviceId: "dawarich-app", state: "running" },
        { serviceId: "dawarich-sidekiq", state: "running" },
        { serviceId: "dawarich-postgis", state: "running" },
        { serviceId: "dawarich-redis", state: "running" },
      ],
      appliedGenerations: {
        app: "0123456789abcdef0123456789abcdef",
        worker: "fedcba9876543210fedcba9876543210",
      },
    });
    expect(calls).toEqual([
      ["compose", "-f", "/trusted/compose.yml", "ps", "--format", "json"],
      [
        "compose",
        "-f",
        "/trusted/compose.yml",
        "exec",
        "-T",
        "dawarich-app",
        "printenv",
        "OPENMAPX_PROVISIONING_GENERATION",
      ],
      [
        "compose",
        "-f",
        "/trusted/compose.yml",
        "exec",
        "-T",
        "dawarich-sidekiq",
        "printenv",
        "OPENMAPX_PROVISIONING_GENERATION",
      ],
    ]);
  });

  it("follows one fixed service with a bounded duration and typed event emitter", async () => {
    const emitted: Array<{ stream: "stdout" | "stderr"; message: string }> = [];
    const followLogs = vi.fn(async (_file, args, options) => {
      expect(args).toEqual([
        "compose",
        "-f",
        "/trusted/compose.yml",
        "logs",
        "-f",
        "--no-color",
        "--tail=20",
        "redis",
      ]);
      expect(options.timeout).toBe(3_000);
      options.onLine("stdout", "ready");
      options.onLine("stderr", "bounded warning");
      return { lines: 2, truncated: false };
    });
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async () => ({ stdout: "", stderr: "" }),
      followLogs,
    });

    await expect(
      dispatchOpsOperation(
        runtime,
        {
          kind: "service.logs.follow",
          serviceId: "redis",
          tail: 20,
          maxDurationSeconds: 3,
        },
        {
          ...context(),
          emitLog: (stream, message) => emitted.push({ stream, message }),
        },
      ),
    ).resolves.toEqual({ lines: 2, truncated: false });
    expect(emitted).toEqual([
      { stream: "stdout", message: "ready" },
      { stream: "stderr", message: "bounded warning" },
    ]);
  });

  it("bounds snapshot log lines in UTF-8 bytes and reports truncation", async () => {
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: async () => ({ stdout: `${"😀".repeat(1_500)}\nsecond\nthird\n`, stderr: "" }),
    });
    const result = await dispatchOpsOperation(
      runtime,
      { kind: "service.logs", serviceId: "redis", tail: 2 },
      context(),
    );
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(2);
    expect(Buffer.byteLength(result.lines[0] ?? "", "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("decodes split UTF-8 follow chunks and contains callback failures", async () => {
    const messages: string[] = [];
    await expect(
      runContainedLogProcess(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>process.stdout.end(Buffer.from([0x98,0x80,0x0a])),10)",
        ],
        {
          signal: new AbortController().signal,
          timeout: 1_000,
          maxBuffer: 1_024,
          onLine: (_stream, message) => messages.push(message),
        },
      ),
    ).resolves.toEqual({ lines: 1, truncated: false });
    expect(messages).toEqual(["😀"]);

    await expect(
      runContainedLogProcess(process.execPath, ["-e", "console.log('line')"], {
        signal: new AbortController().signal,
        timeout: 1_000,
        maxBuffer: 1_024,
        onLine: () => {
          throw new Error("sink secret");
        },
      }),
    ).rejects.toThrow("Contained log process failed");
  });

  it("caps newline-flood event work and reports self-limit truncation", async () => {
    let emitted = 0;
    await expect(
      runContainedLogProcess(
        process.execPath,
        ["-e", "process.stdout.write('x\\n'.repeat(600000)); setInterval(()=>{},1000)"],
        {
          signal: new AbortController().signal,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          onLine: () => {
            emitted += 1;
          },
        },
      ),
    ).resolves.toEqual({ lines: 2_000, truncated: true });
    expect(emitted).toBe(2_000);
  });

  it.each([
    ["nonzero", "process.stdout.write('x'.repeat(5000)+'\\n'); process.exit(7)"],
    ["signal", "process.stdout.write('x'.repeat(5000)+'\\n'); process.kill(process.pid,'SIGTERM')"],
  ])("does not hide a real child %s after content truncation", async (_label, script) => {
    await expect(
      runContainedLogProcess(process.execPath, ["-e", script], {
        signal: new AbortController().signal,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        onLine: () => undefined,
      }),
    ).rejects.toThrow("Contained log process failed");
  });

  it("terminates a signal-ignoring child and bounds captured output", async () => {
    const controller = new AbortController();
    const root = mkdtempSync(join(tmpdir(), "openmapx-contained-child-"));
    const ready = join(root, "ready");
    const startedAt = Date.now();
    const hung = runContainedProcess(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'ready'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
        ready,
      ],
      { signal: controller.signal, timeout: 5_000, maxBuffer: 1_024, killGraceMs: 20 },
    );
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(existsSync(ready)).toBe(true);
    controller.abort();
    await expect(hung).rejects.toThrow("Contained process failed");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    rmSync(root, { recursive: true, force: true });

    await expect(
      runContainedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], {
        signal: new AbortController().signal,
        timeout: 5_000,
        maxBuffer: 1_024,
        killGraceMs: 20,
      }),
    ).rejects.toThrow("Contained process failed");
  });

  it("cancels an extended lifecycle command and contains its process group", async () => {
    const controller = new AbortController();
    const root = mkdtempSync(join(tmpdir(), "openmapx-lifecycle-cancel-"));
    const ready = join(root, "ready");
    const marker = join(root, "late-side-effect");
    const script = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const descendant = [
        'const { writeFileSync } = require("node:fs")',
        'process.on("SIGTERM", () => {})',
        'writeFileSync(process.argv[1], "ready")',
        'setTimeout(() => writeFileSync(process.argv[2], "late"), 5_000)',
        'setInterval(() => {}, 1000)',
      ].join(";");
      spawn(process.execPath, ["-e", descendant, process.argv[1], process.argv[2]], {
        stdio: "ignore",
      });
      setInterval(() => {}, 1000);
    `;
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: (_file, _args, options) =>
        runContainedProcess(process.execPath, ["-e", script, ready, marker], {
          ...options,
          killGraceMs: 20,
        }),
    });
    const operation = dispatchOpsOperation(
      runtime,
      { kind: "service.stop", serviceId: "postgis" },
      { ...context(), signal: controller.signal },
    );
    const rejected = expect(operation).rejects.toThrow("Contained process failed");
    try {
      const readyDeadline = Date.now() + 4_000;
      while (!existsSync(ready) && Date.now() < readyDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(ready)).toBe(true);
      controller.abort();
      await rejected;
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      controller.abort();
      await rejected;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["action", "follow"] as const)(
    "contains a residual TERM-ignoring descendant for %s authority",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "openmapx-contained-group-"));
      const marker = join(root, "late-side-effect");
      const grandchildScript = [
        'const { writeFileSync } = require("node:fs")',
        'process.on("SIGTERM", () => {})',
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "late"), 2_400)`,
        "setInterval(() => {}, 1000)",
      ].join(";");
      const parentScript = [
        'const { spawn } = require("node:child_process")',
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" })`,
        "setTimeout(() => process.exit(0), 50)",
      ].join(";");

      const operation =
        kind === "action"
          ? runContainedProcess(process.execPath, ["-e", parentScript], {
              signal: new AbortController().signal,
              timeout: 5_000,
              maxBuffer: 1_024,
              killGraceMs: 20,
            })
          : runContainedLogProcess(process.execPath, ["-e", parentScript], {
              signal: new AbortController().signal,
              timeout: 5_000,
              maxBuffer: 1_024,
              onLine: () => undefined,
            });

      await expect(operation).rejects.toThrow(/Contained .*process failed/);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(marker)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    },
    12_000,
  );
});

describe("recoverInterruptedTrafficMaintenance", () => {
  const fingerprint = "b".repeat(64);
  const fence = `${JSON.stringify({
    schemaVersion: 1,
    operationId: fingerprint,
    plan: "rebuild-extract",
    startedAt: "2026-10-30T15:44:08.055Z",
  })}\n`;
  const job = (
    state: "failed" | "succeeded",
    errorClass: "recovery_required" | "runtime" | undefined,
    submittedAt = "2026-10-30T15:44:08.048Z",
  ) => ({
    operation: { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" } as OpsOperation,
    fingerprint,
    state,
    ...(errorClass ? { errorClass } : {}),
    submittedAt,
  });
  const withDataRoot = async (
    files: Record<string, string>,
    body: (dataRoot: string, shared: string) => Promise<void>,
  ) => {
    const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-fence-recovery-"));
    const shared = join(dataRoot, "valhalla", "osm-pbf");
    mkdirSync(shared, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(shared, name), contents);
    }
    try {
      await body(dataRoot, shared);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
  const docker =
    (calls: string[][], answers: { remaining?: string; running?: string } = {}) =>
    async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "ps") return { stdout: answers.remaining ?? "", stderr: "" };
      if (args[0] === "inspect") return { stdout: answers.running ?? "false\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

  it("releases the fence of a job the agent was stopped in", async () => {
    await withDataRoot(
      {
        ".traffic-maintenance.json": fence,
        "traffic-generations.json": "{}\n",
        "traffic-generations.unverified.json": "{}\n",
      },
      async (dataRoot, shared) => {
        const calls: string[][] = [];
        await expect(
          recoverInterruptedTrafficMaintenance({
            trafficDataRoot: dataRoot,
            journalRecords: [
              job("succeeded", undefined, "2026-10-29T05:00:00.000Z"),
              job("failed", "recovery_required"),
            ],
            execFile: docker(calls),
            descriptorAnchorRoot: null,
          }),
        ).resolves.toEqual({
          state: "released",
          operationId: fingerprint,
          plan: "rebuild-extract",
        });

        expect(calls).toEqual([
          ["rm", "-f", `openmapx-valhalla-maint-${"b".repeat(16)}`],
          [
            "ps",
            "-a",
            "--filter",
            `name=^/openmapx-valhalla-maint-${"b".repeat(16)}$`,
            "--format",
            "{{.Names}}",
          ],
          ["stop", "--time", "1", "docker-valhalla-1"],
          ["inspect", "--format", "{{.State.Running}}", "docker-valhalla-1"],
        ]);
        expect(calls.some((call) => call[0] === "start")).toBe(false);
        expect(readdirSync(shared).sort()).toEqual([
          `.traffic-maintenance.interrupted-${"b".repeat(16)}.json`,
        ]);
        expect(
          readFileSync(
            join(shared, `.traffic-maintenance.interrupted-${"b".repeat(16)}.json`),
            "utf8",
          ),
        ).toBe(fence);
      },
    );
  });

  it("keeps the fence of a job that failed on its own", async () => {
    await withDataRoot(
      { ".traffic-maintenance.json": fence, "traffic-generations.json": "{}\n" },
      async (dataRoot, shared) => {
        const calls: string[][] = [];
        await expect(
          recoverInterruptedTrafficMaintenance({
            trafficDataRoot: dataRoot,
            journalRecords: [
              job("failed", "recovery_required", "2026-10-28T05:00:00.000Z"),
              job("failed", "runtime"),
            ],
            execFile: docker(calls),
            descriptorAnchorRoot: null,
          }),
        ).resolves.toEqual({ state: "kept", reason: "its job failed on its own" });
        expect(calls).toEqual([]);
        expect(existsSync(join(shared, ".traffic-maintenance.json"))).toBe(true);
        expect(existsSync(join(shared, "traffic-generations.json"))).toBe(true);
      },
    );
  });

  it("keeps a fence written long after the interrupted job it shares a fingerprint with", async () => {
    await withDataRoot({ ".traffic-maintenance.json": fence }, async (dataRoot, shared) => {
      const calls: string[][] = [];
      await expect(
        recoverInterruptedTrafficMaintenance({
          trafficDataRoot: dataRoot,
          // The fence's own (failed, since pruned) job is gone; an older
          // interrupted rebuild with the same fingerprint is retained.
          journalRecords: [job("failed", "recovery_required", "2026-10-20T05:00:00.000Z")],
          execFile: docker(calls),
          descriptorAnchorRoot: null,
        }),
      ).resolves.toEqual({ state: "kept", reason: "the journal holds no job for the fence" });
      expect(calls).toEqual([]);
      expect(existsSync(join(shared, ".traffic-maintenance.json"))).toBe(true);
    });
  });

  it("keeps the fence when the journal holds no job for it", async () => {
    await withDataRoot({ ".traffic-maintenance.json": fence }, async (dataRoot, shared) => {
      await expect(
        recoverInterruptedTrafficMaintenance({
          trafficDataRoot: dataRoot,
          journalRecords: [],
          execFile: docker([]),
          descriptorAnchorRoot: null,
        }),
      ).resolves.toEqual({ state: "kept", reason: "the journal holds no job for the fence" });
      expect(existsSync(join(shared, ".traffic-maintenance.json"))).toBe(true);
    });
  });

  it.each([
    ["its maintenance container survives removal", { remaining: "openmapx-valhalla-maint-x\n" }],
    ["Valhalla still runs", { running: "true\n" }],
  ])("keeps the fence when %s", async (_case, answers) => {
    await withDataRoot(
      { ".traffic-maintenance.json": fence, "traffic-generations.json": "{}\n" },
      async (dataRoot, shared) => {
        await expect(
          recoverInterruptedTrafficMaintenance({
            trafficDataRoot: dataRoot,
            journalRecords: [job("failed", "recovery_required")],
            execFile: docker([], answers),
            descriptorAnchorRoot: null,
          }),
        ).resolves.toMatchObject({ state: "kept" });
        expect(existsSync(join(shared, ".traffic-maintenance.json"))).toBe(true);
        expect(existsSync(join(shared, "traffic-generations.json"))).toBe(true);
      },
    );
  });

  it("does nothing without a fence", async () => {
    await withDataRoot({ "traffic-generations.json": "{}\n" }, async (dataRoot, shared) => {
      const calls: string[][] = [];
      await expect(
        recoverInterruptedTrafficMaintenance({
          trafficDataRoot: dataRoot,
          journalRecords: [job("failed", "recovery_required")],
          execFile: docker(calls),
          descriptorAnchorRoot: null,
        }),
      ).resolves.toEqual({ state: "none" });
      expect(calls).toEqual([]);
      expect(existsSync(join(shared, "traffic-generations.json"))).toBe(true);
    });
  });

  it("refuses a fence replaced by a symlink", async () => {
    await withDataRoot({}, async (dataRoot, shared) => {
      const outside = join(dataRoot, "outside.json");
      writeFileSync(outside, fence);
      symlinkSync(outside, join(shared, ".traffic-maintenance.json"));
      await expect(
        recoverInterruptedTrafficMaintenance({
          trafficDataRoot: dataRoot,
          journalRecords: [job("failed", "recovery_required")],
          execFile: docker([]),
          descriptorAnchorRoot: null,
        }),
      ).rejects.toThrow();
      expect(lstatSync(join(shared, ".traffic-maintenance.json")).isSymbolicLink()).toBe(true);
    });
  });
});
