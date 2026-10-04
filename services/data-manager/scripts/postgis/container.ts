import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { getContainerRuntimeClient, Wait } from "testcontainers";

const root = resolve(import.meta.dirname, "../../../..");
export async function startBenchmarkDatabase(diagnostics = true) {
  const manifest = JSON.parse(readFileSync(resolve(root, "services/postgis/service.json"), "utf8"));
  const image = `${manifest.container.image}:${manifest.container.tag}@${manifest.container.digest}`;
  const container = await new PostgreSqlContainer(image)
    .withDatabase("openmapx_benchmark")
    .withUsername("postgres")
    .withPassword(randomBytes(24).toString("hex"))
    .withResourcesQuota({ memory: 2, cpu: 2 })
    .withEnvironment({ PG_STAT_STATEMENTS: String(diagnostics) })
    .withBindMounts([
      {
        source: resolve(root, "services/postgis/scripts/sync-password.sh"),
        target: "/usr/local/bin/openmapx-postgis-entrypoint.sh",
        mode: "ro",
      },
    ])
    .withEntrypoint(["bash", "/usr/local/bin/openmapx-postgis-entrypoint.sh"])
    .withCommand(["postgres"])
    .withHealthCheck({
      test: [
        "CMD-SHELL",
        "pg_isready -U postgres -q && test -f /var/run/postgresql/openmapx-password-synced",
      ],
      interval: 1000,
      timeout: 1000,
      retries: 90,
      startPeriod: 1000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(120000)
    .start();
  const sql = postgres(container.getConnectionUri(), {
    max: 6,
    connect_timeout: 5,
    connection: { statement_timeout: 15000, application_name: "openmapx-synthetic-benchmark" },
    onnotice: () => {},
  });
  try {
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS postgis");
    const runtime = await getContainerRuntimeClient();
    const raw = runtime.container.getById(container.getId());
    const info = await runtime.container.dockerode.info();
    const inspect = await raw.inspect();
    if (inspect.HostConfig.Memory !== 2 * 1024 ** 3 || inspect.HostConfig.NanoCpus !== 2e9)
      throw new Error("Benchmark container limits were not applied");
    const [version] = await sql.unsafe(
      "SELECT current_setting('server_version_num')::int AS postgres, postgis_lib_version() AS postgis",
    );
    return {
      container,
      sql,
      raw,
      metadata: {
        image,
        architecture: info.Architecture,
        dockerOperatingSystem: info.OSType,
        dockerCpuCount: info.NCPU,
        dockerMemoryBytes: info.MemTotal,
        containerMemoryBytes: inspect.HostConfig.Memory,
        containerCpuLimit: inspect.HostConfig.NanoCpus / 1e9,
        postgresVersionNum: Number(version.postgres),
        postgisVersion: String(version.postgis),
      },
      stop: async () => {
        try {
          await sql.end({ timeout: 2 });
        } finally {
          await container.stop();
        }
      },
    };
  } catch (error) {
    try {
      await sql.end({ timeout: 2 });
    } finally {
      await container.stop();
    }
    throw error;
  }
}
export type BenchmarkDatabase = Awaited<ReturnType<typeof startBenchmarkDatabase>>;
