import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commitConfigurationGeneration,
  type CommitConfigurationOptions,
} from "../configuration-generation";
import { GENERATED_COMPOSE_FILE, currentConfigurationFile, stackComposeArgs } from "../deployment";
import type { LoadedService } from "../types";

const lookup = spawnSync("/usr/bin/which", ["docker-compose"], { encoding: "utf8" });
export const installedCompose = lookup.status === 0 ? lookup.stdout.trim() : undefined;
export interface PathConfig {
  name: string;
  services: Record<
    string,
    {
      image: string;
      environment?: Record<string, string>;
      env_file?: { path: string }[];
      volumes?: { target: string; source: string }[];
    }
  >;
  secrets: Record<string, { file: string }>;
}
export async function composePathHost() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openmapx-compose-paths-")));
  const infraDir = join(root, "infra/docker");
  mkdirSync(infraDir, { recursive: true });
  const loaded: LoadedService[] = ["app-api", "alpha"].map((id) => {
    const directory = join(root, "services", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "local-public.txt"), "public service fixture\n");
    return {
      manifest: {
        id,
        name: id,
        version: "1.0.0",
        quality: "built-in",
        container: { image: `example/${id}`, tag: "1", envFile: [".env"] },
        bindMounts: [
          { source: "./local-public.txt", target: "/service-public", readOnly: true },
          { source: "@infra:public-data.txt", target: "/infra-public", readOnly: true },
        ],
        configSchema: {
          type: "object",
          properties: { PRIVATE_SETTING: { type: "string", "x-openmapx-secret": true } },
        },
      },
      directory,
      enabled: true,
      isBuiltIn: true,
    };
  });
  writeFileSync(join(infraDir, ".env"), "PUBLIC_FIXTURE_SETTING=synthetic-public\n", {
    mode: 0o600,
  });
  writeFileSync(join(infraDir, "public-data.txt"), "public infrastructure fixture\n");
  writeFileSync(join(infraDir, "overlay-public.txt"), "public overlay fixture\n");
  const stack = {
    infraDir,
    composePath: currentConfigurationFile(infraDir, GENERATED_COMPOSE_FILE),
    composeReleasePath: join(infraDir, "docker-compose.release.yml"),
  };
  writeFileSync(
    stack.composeReleasePath,
    "services:\n  alpha:\n    image: example/alpha:release\n    volumes:\n      - ../overlay-public.txt:/overlay-public:ro\n",
  );
  const dockerConfig = join(root, "docker-config");
  mkdirSync(join(dockerConfig, "cli-plugins"), { recursive: true });
  if (installedCompose)
    symlinkSync(installedCompose, join(dockerConfig, "cli-plugins/docker-compose"));
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root, DOCKER_CONFIG: dockerConfig };
  const commit = (
    version: string,
    ownership?: CommitConfigurationOptions["ownedServiceGenerations"],
  ) =>
    commitConfigurationGeneration({
      infraDir,
      services: loaded,
      ownedServiceGenerations: ownership,
      observedServiceContainerIds: ownership?.map((entry) => entry.containerId),
      input: {
        domain: "fixture.example.test",
        selectedRoots: ["app-api", "alpha"],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: loaded.map((service) => ({
          serviceId: service.manifest.id,
          values: { PRIVATE_SETTING: `synthetic-public-fixture-${version}` },
        })),
      },
    });
  const first = await commit("first");
  const firstCompose = realpathSync(stack.composePath);
  const secretFile = (compose: string, id = "alpha") =>
    join(dirname(compose), ".generated-secrets", id, "PRIVATE_SETTING");
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const sameFile = (a: string, b: string) => {
    const x = statSync(a),
      y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  };
  const record = (entry: unknown) => {
    const output = process.env.OMX_TASK011_FIX1_EVIDENCE;
    if (!output) return;
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `compose-${randomUUID()}.json`), JSON.stringify(entry, null, 2));
  };
  const runConfigArgv = (argv: readonly string[]) => {
    const before = new Date().toISOString();
    const result = spawnSync("docker", argv, {
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    record({
      argv: ["docker", ...argv],
      startUTC: before,
      endUTC: new Date().toISOString(),
      exit: result.status,
      errorCode: result.error && "code" in result.error ? result.error.code : null,
      stderr: result.stderr,
      stdoutSHA256: createHash("sha256")
        .update(result.stdout ?? "")
        .digest("hex"),
      stdoutOmitted: "Contains fixture configuration; path/inode checks are recorded separately",
      environmentKeys: Object.keys(env),
    });
    return {
      status: result.status,
      model: result.status === 0 ? (JSON.parse(result.stdout) as PathConfig) : undefined,
    };
  };
  const config = (args: readonly string[], noEnvResolution = false) =>
    runConfigArgv([
      ...args,
      "config",
      "--format",
      "json",
      ...(noEnvResolution ? ["--no-env-resolution"] : []),
    ]);
  const pathChecks = (model: PathConfig, compose: string) => {
    const checks: Record<string, boolean> = {
      releaseImage: model.services.alpha?.image === "example/alpha:release",
    };
    for (const service of loaded) {
      const id = service.manifest.id,
        entry = model.services[id];
      checks[`${id}.infraBind`] = sameFile(
        entry?.volumes?.find((v) => v.target === "/infra-public")?.source ?? "",
        join(infraDir, "public-data.txt"),
      );
      checks[`${id}.serviceBind`] = sameFile(
        entry?.volumes?.find((v) => v.target === "/service-public")?.source ?? "",
        join(service.directory, "local-public.txt"),
      );
      const secret = Object.values(model.secrets).find((s) =>
        s.file.endsWith(`/${id}/PRIVATE_SETTING`),
      );
      checks[`${id}.secret`] = sameFile(secret?.file ?? "", secretFile(compose, id));
      if (entry?.env_file)
        checks[`${id}.envFile`] = sameFile(entry.env_file[0]?.path ?? "", join(infraDir, ".env"));
      else
        checks[`${id}.envFileRead`] =
          entry?.environment?.PUBLIC_FIXTURE_SETTING === "synthetic-public";
    }
    checks.overlayBind = sameFile(
      model.services.alpha?.volumes?.find((v) => v.target === "/overlay-public")?.source ?? "",
      join(infraDir, "overlay-public.txt"),
    );
    record({
      pathChecks: checks,
      generationFile: compose,
      generationSHA256: hash(compose),
      secretInodes: loaded.map((s) => {
        const stat = statSync(secretFile(compose, s.manifest.id));
        return { serviceId: s.manifest.id, dev: stat.dev, ino: stat.ino };
      }),
    });
    return checks;
  };
  return {
    root,
    infraDir,
    stack,
    loaded,
    first,
    firstCompose,
    env,
    config,
    runConfigArgv,
    pathChecks,
    commit,
    secretFile,
    hash,
    sameFile,
    currentArgs: () => stackComposeArgs(stack, existsSync),
    retainedArgs: () => stackComposeArgs({ ...stack, composePath: firstCompose }, existsSync),
  };
}
