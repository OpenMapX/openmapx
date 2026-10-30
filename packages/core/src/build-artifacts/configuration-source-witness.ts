import { createHmac, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import {
  type ConfigurationSourcesInspection,
  configurationSourcesInspectionSchema,
} from "../ops/configuration-preparation";
import { serviceConfigEnvPrefix } from "../services/config-resolver";
import {
  currentConfigurationGeneration,
  readAppliedPlatformConfiguration,
} from "../services/configuration-generation";
import { SERVICE_SELECTION_FILE } from "../services/deployment";
import type { LoadedService } from "../services/types";
import {
  type ControlInstallation,
  installationState,
  readPrivateRecord,
  writePrivateRecord,
} from "./control-authority";
import { signControl, verifyControl } from "./control-records";

const domain = "openmapx-configuration-source-witness-v1";
const witnessSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  inspection: configurationSourcesInspectionSchema,
  authorityRevision: z.string().max(128),
  observation: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().safe(),
  pins: z.array(z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/)).max(128),
});
const name = (id: string) => `configuration-source-${z.uuid().parse(id)}.json`;
function hostEnv(infraDir: string, env: NodeJS.ProcessEnv) {
  const path = join(infraDir, ".env");
  let file: NodeJS.ProcessEnv = {};
  let fd: number | undefined;
  let identity: unknown = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024)
      throw Error("Host sources unavailable");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd),
      current = lstatSync(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Host sources unavailable");
    file = parseEnv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    identity = {
      dev: before.dev,
      ino: before.ino,
      mtime: before.mtimeMs,
      ctime: before.ctimeMs,
      size: before.size,
    };
  } catch (error) {
    if (fd !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let selection: { identity: unknown; bytes: string } | null = null;
  let selectionFd: number | undefined;
  try {
    const path = join(infraDir, SERVICE_SELECTION_FILE);
    selectionFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(selectionFd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536)
      throw Error("Host sources unavailable");
    const bytes = readFileSync(selectionFd),
      after = fstatSync(selectionFd),
      current = lstatSync(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Host sources unavailable");
    selection = {
      identity: {
        dev: before.dev,
        ino: before.ino,
        mtime: before.mtimeMs,
        ctime: before.ctimeMs,
        size: before.size,
      },
      bytes: bytes.toString("base64"),
    };
  } catch (error) {
    if (selectionFd !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  } finally {
    if (selectionFd !== undefined) closeSync(selectionFd);
  }
  return { env: { ...file, ...env }, identity, selection };
}

/** Private, bounded source capture. Raw overlay bytes never enter the public inspection. */
function releaseSource(infraDir: string) {
  const path = join(infraDir, "docker-compose.release.yml");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024)
      throw Error("Host sources unavailable");
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      current = lstatSync(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs
    )
      throw Error("Host sources unavailable");
    return {
      identity: {
        dev: before.dev,
        ino: before.ino,
        mtime: before.mtimeMs,
        ctime: before.ctimeMs,
        size: before.size,
      },
      bytes: bytes.toString("base64"),
    };
  } catch (error) {
    if (fd !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function currentSources(infraDir: string, env: NodeJS.ProcessEnv) {
  const platform = readAppliedPlatformConfiguration(infraDir);
  return {
    ...hostEnv(infraDir, env),
    release: releaseSource(infraDir),
    ...(platform ? { platform } : {}),
  };
}

/** The renderer's supported resource interpolation is a finite mapping. */
export function configurationHostFields(
  services: readonly LoadedService[],
  env: NodeJS.ProcessEnv,
) {
  const memory: Record<string, string> = {
    brouter: "BROUTER_MEMORY",
    "local-ai": "LOCAL_AI_MEMORY",
    motis: "MOTIS_SLOT_MEMORY",
    "motis-staging": "MOTIS_SLOT_MEMORY",
    postgis: "POSTGIS_MEMORY",
  };
  return services.map(({ manifest, isBuiltIn }) => {
    const schema = (manifest.configSchema?.properties ?? manifest.configSchema ?? {}) as Record<
      string,
      unknown
    >;
    const declared = Object.entries(schema)
      .filter(
        ([key, definition]) =>
          key !== "type" &&
          key !== "properties" &&
          definition !== null &&
          typeof definition === "object" &&
          !Array.isArray(definition),
      )
      .map(([key]) => key);
    const keys = new Set([...declared, "OPENMAPX_MEMORY_MIB", "OPENMAPX_CPU_LIMIT"]);
    const fields = [...keys].sort().map((key) => {
      const names = [`${serviceConfigEnvPrefix(manifest.id)}${key.toUpperCase()}`];
      const hostExpression = manifest.container.environment?.[key]?.match(
        /^\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}$/,
      )?.[1];
      if (isBuiltIn && hostExpression) names.push(hostExpression);
      const variable = memory[manifest.id];
      if (
        isBuiltIn &&
        key === "OPENMAPX_MEMORY_MIB" &&
        variable &&
        manifest.container.memory?.startsWith(`\${${variable}`)
      )
        names.push(variable);
      const envVar = names.find((name) => env[name] !== undefined && env[name] !== "");
      return {
        key,
        source: envVar ? ("host" as const) : ("none" as const),
        ...(envVar ? { envVar } : {}),
      };
    });
    return { serviceId: manifest.id, fields };
  });
}
export function observeConfigurationSources(options: {
  installation: ControlInstallation;
  infraDir: string;
  services: readonly LoadedService[];
  authorityRevision: string;
  env?: NodeJS.ProcessEnv;
}): ConfigurationSourcesInspection {
  const state = installationState(options.installation);
  if (options.installation.role !== "ops-agent") throw Error("Host sources unavailable");
  for (let attempt = 0; attempt < 3; attempt++) {
    const revisionId = currentConfigurationGeneration(options.infraDir);
    const observed = currentSources(options.infraDir, options.env ?? process.env);
    const recheck = currentSources(options.infraDir, options.env ?? process.env);
    if (
      revisionId !== currentConfigurationGeneration(options.infraDir) ||
      canonicalJson(observed) !== canonicalJson(recheck)
    )
      continue;
    const inspection = configurationSourcesInspectionSchema.parse({
      revisionId,
      ...(observed.platform ? { platform: observed.platform } : {}),
      sourceRevision: randomUUID(),
      services: configurationHostFields(options.services, observed.env),
    });
    const key = state.privateKey.export({ type: "pkcs8", format: "der" });
    const observation = createHmac("sha256", key)
      .update(`${domain}\0`)
      .update(canonicalJson(observed))
      .digest("hex");
    const directory = state.privateRoot.directory("observations", true, true);
    try {
      let count = 0,
        bytes = 0;
      for (const entry of directory
        .listBounded(4096)
        .filter((entry) => /^configuration-source-/.test(entry))) {
        const retained = verifyControl(
          options.installation.publicKey,
          domain,
          JSON.parse(directory.read(entry, 128 * 1024).toString("utf8")),
          witnessSchema,
        );
        if (retained.expiresAt <= Date.now() && !retained.pins.length) {
          directory.removeFile(entry);
          continue;
        }
        count++;
        bytes += directory.read(entry, 128 * 1024).length;
      }
      const signed = signControl(
        state.privateKey,
        domain,
        witnessSchema.parse({
          version: 2,
          inspection,
          authorityRevision: options.authorityRevision,
          observation,
          expiresAt: Date.now() + 300000,
          pins: [],
        }),
      );
      if (count >= 128 || bytes + Buffer.byteLength(canonicalJson(signed)) > 1024 * 1024)
        throw Error("Host source witness capacity unavailable");
      writePrivateRecord(state, "observations", name(inspection.sourceRevision), signed, true);
    } finally {
      directory.close();
    }
    return inspection;
  }
  throw Error("Host sources unavailable");
}
export function verifyConfigurationSourceWitness(options: {
  installation: ControlInstallation;
  infraDir: string;
  sourceRevision: string;
  expectedCurrentRevisionId: string | null;
  authorityRevision: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const state = installationState(options.installation);
  const retained = verifyControl(
    options.installation.publicKey,
    domain,
    readPrivateRecord(state, "observations", name(options.sourceRevision)),
    witnessSchema,
  );
  const observed =
    retained.version === 2
      ? currentSources(options.infraDir, options.env ?? process.env)
      : hostEnv(options.infraDir, options.env ?? process.env);
  const key = state.privateKey.export({ type: "pkcs8", format: "der" });
  const digest = createHmac("sha256", key)
    .update(`${domain}\0`)
    .update(canonicalJson(observed))
    .digest("hex");
  if (
    retained.expiresAt <= Date.now() ||
    retained.authorityRevision !== options.authorityRevision ||
    retained.inspection.sourceRevision !== options.sourceRevision ||
    retained.inspection.revisionId !== options.expectedCurrentRevisionId ||
    options.expectedCurrentRevisionId !== currentConfigurationGeneration(options.infraDir) ||
    digest !== retained.observation
  )
    throw Error("Host sources changed");
}
/** New coordinator work requires the release-bound observation. Historical v1
 * witnesses remain readable for their original ordinary work only. */
export function verifyConfigurationReleaseSourceWitness(
  options: Parameters<typeof verifyConfigurationSourceWitness>[0],
): void {
  const retained = verifyControl(
    options.installation.publicKey,
    domain,
    readPrivateRecord(
      installationState(options.installation),
      "observations",
      name(options.sourceRevision),
    ),
    witnessSchema,
  );
  if (retained.version !== 2) throw Error("Release-bound host source required");
  verifyConfigurationSourceWitness(options);
}
