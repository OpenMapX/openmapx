import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { cpus, totalmem } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const scenarios = [
  "initial",
  "unchanged",
  "expiry-only",
  "observation-only",
  "changed",
  "first-register-linking",
  "complete-empty",
] as const;
type Scenario = (typeof scenarios)[number];
const root = resolve(import.meta.dirname, "..");
const images = {
  "16": "postgis/postgis:16-3.4",
  "18": "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8",
};
export function parseArgs(args: string[], env: NodeJS.ProcessEnv) {
  if (
    Object.keys(env).some((key) =>
      /^(DATABASE_URL|PGHOST|PGHOSTADDR|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGPASSFILE|PGSERVICE|PGSERVICEFILE|PGOPTIONS)$/.test(
        key,
      ),
    )
  )
    throw new Error("Connection environment is forbidden; use only owned disposable fixtures");
  const values: Record<string, string> = {};
  const allowed = [
    "baseline-oc-root",
    "candidate-oc-root",
    "runs",
    "output",
    "scenario",
    "postgres-major",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (!name || !allowed.includes(name) || !value || value.startsWith("--"))
      throw new Error("Unknown or incomplete replay argument");
    if (values[name]) throw new Error("Duplicate replay argument");
    values[name] = value;
  }
  const baseline = values["baseline-oc-root"];
  const candidate = values["candidate-oc-root"];
  if (!baseline || !candidate || !isAbsolute(baseline) || !isAbsolute(candidate))
    throw new Error("Explicit absolute baseline and candidate OC worktrees required");
  const runs = Number(values.runs ?? 5);
  if (!Number.isSafeInteger(runs) || runs < 5 || runs > 100)
    throw new Error("Replay needs 5–100 repetitions");
  const scenario = values.scenario ?? "all";
  if (scenario !== "all" && !scenarios.includes(scenario as Scenario))
    throw new Error("Unknown scenario");
  const major = values["postgres-major"] ?? "all";
  if (!["16", "18", "all"].includes(major)) throw new Error("Unsupported PostgreSQL major");
  return {
    baseline,
    candidate,
    runs,
    scenario,
    major,
    output: values.output ?? "plans/replay-results",
  };
}
export function resolveOutput(worktree: string, output: string) {
  worktree = realpathSync(worktree);
  const plans = resolve(worktree, "plans");
  const result = resolve(worktree, output);
  if (result !== plans && !result.startsWith(`${plans}${sep}`))
    throw new Error("Output must stay inside this worktree's plans directory");
  let ancestor = result;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error("Output may not traverse symlinks");
  return result;
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function compareLogical(a: unknown, b: unknown) {
  const baselineHash = digest(a),
    candidateHash = digest(b);
  return { equal: baselineHash === candidateHash, baselineHash, candidateHash };
}
interface ComparisonArm {
  revision: string;
  fixtureHash: string;
  inputHash: string;
  logical: unknown;
}
export function comparePair(baseline: ComparisonArm, candidate: ComparisonArm) {
  if (baseline.fixtureHash !== candidate.fixtureHash)
    throw new Error("Replay fixture identity differs");
  if (baseline.inputHash !== candidate.inputHash) throw new Error("Replay input identity differs");
  return {
    ...compareLogical(baseline.logical, candidate.logical),
    control: baseline.revision === candidate.revision,
  };
}
export interface Counters {
  reset: string;
  values: Record<string, string>;
}
export function counterDelta(before: Counters, after: Counters) {
  if (before.reset !== after.reset) throw new Error("Database counter reset invalidates replay");
  return Object.fromEntries(
    Object.entries(before.values).map(([key, value]) => {
      if (!(key in after.values)) throw new Error("Missing counter");
      const delta = BigInt(after.values[key]) - BigInt(value);
      if (delta < 0n) throw new Error("Counter decreased during replay");
      return [key, delta.toString()];
    }),
  );
}
export function summarize(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new Error("Finite samples required");
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
    count: sorted.length,
  };
}
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export function identifyWorktree(directory: string) {
  const path = realpathSync(directory);
  const gitDir = realpathSync(resolve(path, git(path, ["rev-parse", "--git-dir"])));
  const commonDir = realpathSync(resolve(path, git(path, ["rev-parse", "--git-common-dir"])));
  if (gitDir === commonDir || git(path, ["rev-parse", "--show-toplevel"]) !== path)
    throw new Error("OC root must be an isolated git worktree");
  if (git(path, ["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Commit OC candidate source before replay");
  const pkg = JSON.parse(readFileSync(resolve(path, "packages/storage/package.json"), "utf8"));
  if (pkg.name !== "@openconditions/storage")
    throw new Error("Expected an OpenConditions worktree");
  return { path, revision: git(path, ["rev-parse", "HEAD"]), dirty: false };
}

const buildCommand = ["exec", "turbo", "run", "build", "--force", "--concurrency=1"];
export function validateBuildReuse(
  prior: unknown,
  identities: ReturnType<typeof identifyWorktree>[],
  artifacts: Record<string, string>[],
) {
  if (!prior || typeof prior !== "object") throw new Error("Invalid prior build report");
  const report = prior as { identities?: unknown; builds?: unknown };
  if (digest(report.identities ?? null) !== digest(identities))
    throw new Error("Prior build identity differs");
  if (!Array.isArray(report.builds) || report.builds.length !== identities.length)
    throw new Error("Missing prior build provenance");
  return report.builds.map((build: unknown, index: number) => {
    if (!build || typeof build !== "object") throw new Error("Invalid prior build provenance");
    const result = build as { command?: unknown; exitCode?: unknown; artifacts?: unknown };
    if (
      result.exitCode !== 0 ||
      digest(result.command ?? null) !== digest(["pnpm", ...buildCommand])
    )
      throw new Error("Prior fixed build did not succeed");
    if (
      !artifacts[index] ||
      !Object.keys(artifacts[index]).length ||
      digest(result.artifacts ?? null) !== digest(artifacts[index])
    )
      throw new Error("Prior built artifacts differ");
    return {
      command: ["pnpm", ...buildCommand],
      exitCode: 0,
      artifacts: artifacts[index],
      reusedFromPreviousRun: true,
    };
  });
}
function artifactHashes(worktree: string) {
  const entries: [string, string][] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Built artifacts may not be symlinks");
      if (entry.isDirectory()) collect(file);
      else
        entries.push([
          relative(worktree, file),
          createHash("sha256").update(readFileSync(file)).digest("hex"),
        ]);
    }
  };
  for (const area of ["packages", "services"]) {
    for (const entry of readdirSync(resolve(worktree, area), { withFileTypes: true })) {
      const dist = resolve(worktree, area, entry.name, "dist");
      if (entry.isDirectory() && existsSync(dist)) {
        if (lstatSync(dist).isSymbolicLink())
          throw new Error("Built artifacts may not be symlinks");
        collect(dist);
      }
    }
  }
  if (!entries.length) throw new Error("Build produced no artifacts");
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
interface ReplayCompletion {
  runs: Record<string, unknown>;
  summary: Record<string, unknown>;
}

interface ReplayInvocation {
  previousReport: unknown;
  writeRuns(report: Record<string, unknown>): void;
}

export async function runReplayInvocation(
  output: string,
  work: (invocation: ReplayInvocation) => Promise<ReplayCompletion>,
): Promise<void> {
  mkdirSync(output, { recursive: true });
  const invocationId = randomUUID();
  const startedAt = new Date().toISOString();
  const atomic = (name: string, value: Record<string, unknown>) => {
    const target = resolve(output, name);
    if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))
      throw new Error("Replay report must be a regular owned file");
    const temporary = resolve(output, `.${name}.${invocationId}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const stamp = (report: Record<string, unknown>, status: "INCOMPLETE" | "COMPLETE") => ({
    ...report,
    invocationId,
    startedAt,
    status,
  });
  atomic("summary.json", stamp({}, "INCOMPLETE"));
  let previousReport: unknown;
  try {
    const previous = resolve(output, "runs.json");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        previous,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (descriptor !== undefined) {
      try {
        if (!fstatSync(descriptor).isFile())
          throw new Error("Prior build report must be a regular owned file");
        previousReport = JSON.parse(readFileSync(descriptor, "utf8"));
      } finally {
        closeSync(descriptor);
      }
    }
  } finally {
    const prior = previousReport as { identities?: unknown; builds?: unknown } | undefined;
    atomic(
      "runs.json",
      stamp({ identities: prior?.identities, builds: prior?.builds, results: [] }, "INCOMPLETE"),
    );
  }
  const completed = await work({
    previousReport,
    writeRuns: (report) => atomic("runs.json", stamp(report, "INCOMPLETE")),
  });
  atomic("runs.json", stamp(completed.runs, "COMPLETE"));
  atomic("summary.json", stamp(completed.summary, "COMPLETE"));
}

let phase = "argument validation";
async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const output = resolveOutput(root, options.output);
  phase = "output invocation";
  await runReplayInvocation(output, (invocation) => replay(options, invocation));
}

async function replay(
  options: ReturnType<typeof parseArgs>,
  invocation: ReplayInvocation,
): Promise<ReplayCompletion> {
  phase = "worktree identity";
  const identities = [identifyWorktree(options.baseline), identifyWorktree(options.candidate)];
  phase = "serialized OC builds";
  const builds =
    invocation.previousReport !== undefined
      ? validateBuildReuse(
          invocation.previousReport,
          identities,
          identities.map((identity) => artifactHashes(identity.path)),
        )
      : identities.map((identity) => {
          execFileSync("pnpm", buildCommand, {
            cwd: identity.path,
            stdio: "pipe",
            maxBuffer: 16 * 1024 * 1024,
          });
          if (identifyWorktree(identity.path).revision !== identity.revision)
            throw new Error("OC source changed during build");
          return {
            command: ["pnpm", ...buildCommand],
            exitCode: 0,
            artifacts: artifactHashes(identity.path),
          };
        });
  phase = "dependency resolution";
  // Resolve every package and fixture before allocating a disposable instance.
  const omxRequire = createRequire(resolve(root, "services/data-manager/package.json"));
  const { PostgreSqlContainer } = omxRequire("@testcontainers/postgresql");
  const postgres = omxRequire("postgres");
  await import(
    pathToFileURL(resolve(root, "services/data-manager/__tests__/helpers/postgis-testcontainer.ts"))
      .href
  );
  const implementations = await Promise.all(
    identities.map(async (identity) => {
      const scoped = createRequire(resolve(identity.path, "packages/storage/package.json"));
      const load = (name: string) => import(pathToFileURL(scoped.resolve(name)).href);
      const storage = await load("@openconditions/storage");
      const core = await load("@openconditions/core/server");
      const model = await load("@openconditions/model");
      await load("@openconditions/model-registry");
      const fixtures = resolve(identity.path, "packages/storage/src/__tests__");
      await import(pathToFileURL(resolve(fixtures, "database.integration.ts")).href);
      const drafts = await import(pathToFileURL(resolve(fixtures, "drafts.ts")).href);
      const facilities = await import(
        pathToFileURL(resolve(fixtures, "facility-fixtures.ts")).href
      );
      return {
        storage,
        facilities,
        model,
        core,
        registry: facilities.registry,
        drafts,
        fixtureHash: digest([
          readFileSync(import.meta.filename, "utf8"),
          readFileSync(resolve(fixtures, "drafts.ts"), "utf8"),
          readFileSync(resolve(fixtures, "facility-fixtures.ts"), "utf8"),
          readFileSync(
            resolve(identity.path, "packages/model-registry/src/__tests__/golden/facilities.json"),
            "utf8",
          ),
        ]),
      };
    }),
  );
  if (implementations[0].fixtureHash !== implementations[1].fixtureHash)
    throw new Error("Baseline and candidate fixtures differ");
  const report: Record<string, unknown> = {
    identities,
    builds,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostCpus: cpus().length,
      hostMemoryBytes: totalmem(),
    },
    fixture: {
      kind: "sanctioned synthetic storage fixture",
      features: 32,
      firstRegisterFeaturesPerSource: 128,
      componentsPerFeature: 3,
      hash: implementations[0].fixtureHash,
    },
    control: identities[0].revision === identities[1].revision,
    thresholds: {
      unexplainedDifferences: 0,
      unaffectedMedianRegressionPercent: 5,
      substantialOptimizationTargetPercent: 20,
    },
    limitations: [
      "Synthetic fixture is not a production-scale restore",
      "Native rights, failure/concurrency and fusion suites remain required",
      "RSS samples are point-in-time, not a server high-water mark",
      "No publication deadline modeled by storage-only replay",
    ],
    clock: ["2026-10-01T10:00:05.000Z", "2026-10-01T10:01:05.000Z"],
    warmPolicy:
      "owned cluster per PostgreSQL major; fresh migrated database per arm, dropped before next arm; seeded warm connection; no counter resets",
  };
  let labelsVerified = false;
  const results: Record<string, unknown>[] = [];
  const selected = options.scenario === "all" ? scenarios : [options.scenario as Scenario];
  for (const major of (options.major === "all"
    ? ["16", "18"]
    : [options.major]) as (keyof typeof images)[]) {
    phase = `PostgreSQL ${major} container startup`;
    const container = await new PostgreSqlContainer(images[major])
      .withDatabase("replay_owned")
      .withUsername("replay")
      .withPassword("replay-fixture-only")
      .withStartupTimeout(120_000)
      .withCommand([
        "postgres",
        "-c",
        "shared_preload_libraries=pg_stat_statements",
        "-c",
        "pg_stat_statements.track_planning=off",
      ])
      .start();
    const sampleRuntime = async () => {
      const read = async (path: string) => {
        const result = await container.exec(["cat", path]);
        return result.exitCode === 0 ? result.output : null;
      };
      const status = await read("/proc/1/status");
      const memory = await read("/proc/meminfo");
      return {
        serverRssBytes: status?.match(/^VmRSS:\s+(\d+) kB/m)
          ? Number(status.match(/^VmRSS:\s+(\d+) kB/m)[1]) * 1024
          : null,
        containerHostMemoryBytes: memory?.match(/^MemTotal:\s+(\d+) kB/m)
          ? Number(memory.match(/^MemTotal:\s+(\d+) kB/m)[1]) * 1024
          : null,
        cpuPressure: await read("/proc/pressure/cpu"),
        ioPressure: await read("/proc/pressure/io"),
      };
    };
    const admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
    let sequence = 0;
    try {
      for (const scenario of selected) {
        for (let run = 0; run < options.runs; run++) {
          const pair: { logical: unknown; result: Record<string, unknown> }[] = [];
          const order = Math.random() < 0.5 ? [0, 1] : [1, 0];
          for (const index of order) {
            const implementation = implementations[index];
            const database = `replay_${sequence++}`;
            await admin.unsafe(`CREATE DATABASE ${database}`);
            let sql: ReturnType<typeof postgres> | undefined;
            let workload: ReturnType<typeof postgres> | undefined;
            try {
              const ownedUrl = new URL(container.getConnectionUri());
              ownedUrl.pathname = `/${database}`;
              const uri = ownedUrl.href;
              sql = postgres(uri, {
                max: 1,
                onnotice: () => {},
                connection: { application_name: "openmapx-replay-observer" },
              });
              await sql.unsafe(
                "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
              );
              if (!labelsVerified) {
                process.env.DATABASE_URL = uri;
                try {
                  for (const [file, label, pool] of [
                    ["apps/api/src/db/index.ts", "openmapx-api", 10],
                    ["services/data-manager/src/db/index.ts", "openmapx-data-manager", 4],
                  ] as const) {
                    const { sql: labelled } = await import(pathToFileURL(resolve(root, file)).href);
                    try {
                      const [activity] = await labelled.unsafe(
                        "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()",
                      );
                      if (activity.application_name !== label || labelled.options.max !== pool)
                        throw new Error("Application label or pool limit differs");
                    } finally {
                      await labelled.end({ timeout: 2 });
                    }
                  }
                  labelsVerified = true;
                  report.applicationNamesVerified = true;
                } finally {
                  // biome-ignore lint/suspicious/noUndeclaredEnvVars: The standalone harness owns this temporary connection environment outside Turbo.
                  delete process.env.DATABASE_URL;
                }
              }
              const t0 = "2026-10-01T10:00:05.000Z",
                t1 = "2026-10-01T10:01:05.000Z";
              await sql.unsafe(`CREATE SCHEMA replay_clock;
              CREATE FUNCTION replay_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT current_setting(''replay.now'')::timestamptz';
              SET search_path = replay_clock, pg_catalog, public;
              SET replay.now = '${t0}';
              ALTER DATABASE ${database} SET search_path TO replay_clock, pg_catalog, public;
              ALTER DATABASE ${database} SET replay.now TO '${t0}'`);
              phase = `PostgreSQL ${major} migrations`;
              await implementation.core.runMigrations(uri);
              const [version] = await sql.unsafe(
                "SELECT current_setting('server_version_num') AS major, postgis_lib_version() AS postgis, version() AS server, pg_postmaster_start_time() AS started",
              );
              if (
                Math.floor(Number(version.major) / 10000) !== Number(major) ||
                !version.postgis.startsWith(major === "16" ? "3.4" : "3.6")
              )
                throw new Error("Disposable server version mismatch");
              phase = `PostgreSQL ${major} ${scenario} fixture`;
              const { storage, drafts, registry, facilities, model } = implementation;
              const defaults = await sql.unsafe(
                "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='conditions' AND column_default='now()'",
              );
              for (const column of defaults) {
                if (
                  !/^[a-z_0-9]+$/.test(column.table_name) ||
                  !/^[a-z_0-9]+$/.test(column.column_name)
                )
                  throw new Error("Unexpected fixture clock identifier");
                await sql.unsafe(
                  `ALTER TABLE conditions.${column.table_name} ALTER COLUMN ${column.column_name} SET DEFAULT replay_clock.now()`,
                );
              }
              await storage.ensureObservationPartitions(sql, {
                classes: storage.retentionClasses(registry),
                now: new Date(t0),
              });
              const golden = facilities.goldenFacilities();
              const sourceTiers = Object.fromEntries(
                [...golden.keys()].map((source) => [source, "authoritative"]),
              );
              if (scenario === "first-register-linking") {
                sourceTiers["replay-regional"] = "authoritative";
                sourceTiers["replay-national"] = "authoritative";
              }
              await facilities.seedSources(sql, sourceTiers);
              for (const source of Object.keys(sourceTiers))
                await facilities.polled(sql, source, t0);
              const features = Array.from({ length: 32 }, (_, i) =>
                drafts.featureDraft(`s${i + 1}`, 3),
              );
              const context = (now: string, complete = false) => ({
                registry,
                instanceId: "replay.local",
                now,
                complete,
              });
              const write = async (
                client: ReturnType<typeof postgres>,
                payload: Record<string, unknown>,
                now: string,
                complete = false,
              ) => {
                const result = await storage.writeSnapshot(
                  client,
                  "nl-ndw-flow",
                  payload,
                  context(now, complete),
                );
                if (result.rejected.length) throw new Error("Fixture records rejected");
              };
              const seedOtherClasses = async (client: ReturnType<typeof postgres>, now: string) => {
                for (const [source, payload] of golden) {
                  const shifted = JSON.parse(
                    JSON.stringify(payload).replaceAll("2026-09-22", "2026-10-01"),
                  );
                  for (const observation of shifted.observations ?? [])
                    observation.id = model.observationId(source, observation);
                  const summary = await storage.writeSnapshot(
                    client,
                    source,
                    shifted,
                    context(now),
                  );
                  if (summary.rejected.length) throw new Error("Golden fixture rejected");
                }

                for (const [source, payload] of [
                  ["nl-ndw-events", { situations: [drafts.situationDraft("a")] }],
                  ["de-parking", { offers: [drafts.offerDraft("a")] }],
                ] as const) {
                  const result = await storage.writeSnapshot(client, source, payload, context(now));
                  if (result.rejected.length) throw new Error("Fixture records rejected");
                }
              };
              const { components: _components, ...template } = facilities
                .goldenFacilities()
                .get("de-bw-mobidata-charging").features[0];
              const register = (source: string) =>
                Array.from({ length: 128 }, (_, i) => ({
                  ...template,
                  id: `oc:feature:${source}:${i}`,
                  externalIds: [{ scheme: "bnetza", id: `replay-${i}` }],
                  provenance: { ...template.provenance, sourceId: source, recordId: String(i) },
                  location: {
                    ...template.location,
                    geometry: {
                      type: "Point",
                      coordinates: [7 + (i % 16) * 0.01, 51 + Math.floor(i / 16) * 0.01],
                    },
                  },
                  freshness: { fetchedAt: t0 },
                }));
              const regional = register("replay-regional"),
                national = register("replay-national");
              if (scenario === "first-register-linking") {
                for (const draft of [...regional, ...national]) {
                  if (!registry.validateDraft(draft).ok)
                    throw new Error("Invalid register fixture draft");
                }
                const seed = await storage.writeSnapshot(
                  sql,
                  "replay-regional",
                  { features: regional },
                  context(t0),
                );
                if (seed.rejected.length) throw new Error("Register fixture rejected");
              } else if (scenario !== "initial") {
                await write(sql, { features }, t0);
                await seedOtherClasses(sql, t0);
              }
              await sql.unsafe("SELECT pg_stat_force_next_flush()");
              const counters = async () => {
                await sql.unsafe("SELECT pg_stat_clear_snapshot()");
                const [db] = await sql.unsafe(
                  "SELECT stats_reset::text AS reset, temp_files::text, temp_bytes::text, xact_commit::text, xact_rollback::text FROM pg_stat_database WHERE datname = current_database()",
                );
                const [statementReset] = await sql.unsafe(
                  "SELECT stats_reset::text AS reset FROM pg_stat_statements_info",
                );
                const [wal] = await sql.unsafe(
                  "SELECT stats_reset::text AS reset, wal_records::text, wal_fpi::text, wal_bytes::text FROM pg_stat_wal",
                );
                const tables = await sql.unsafe(
                  "SELECT relname, n_tup_ins::text, n_tup_upd::text, n_tup_del::text, n_tup_hot_upd::text FROM pg_stat_user_tables WHERE schemaname = 'conditions' ORDER BY relname",
                );
                const values: Record<string, string> = {};
                for (const [key, value] of Object.entries(db))
                  if (key !== "reset") values[`database.${key}`] = String(value);
                for (const [key, value] of Object.entries(wal))
                  if (key !== "reset") values[`wal.${key}`] = String(value);
                for (const table of tables)
                  for (const [key, value] of Object.entries(table))
                    if (key !== "relname") values[`table.${table.relname}.${key}`] = String(value);
                return {
                  reset: JSON.stringify([
                    version.started,
                    db.reset,
                    wal.reset,
                    statementReset.reset,
                  ]),
                  values,
                };
              };
              const statementCounters = async () =>
                (
                  await sql.unsafe(
                    "SELECT coalesce(sum(calls),0)::text AS calls, coalesce(sum(rows),0)::text AS rows, coalesce(sum(shared_blks_hit),0)::text AS shared_blks_hit, coalesce(sum(shared_blks_read),0)::text AS shared_blks_read, coalesce(sum(shared_blks_dirtied),0)::text AS shared_blks_dirtied, coalesce(sum(temp_blks_written),0)::text AS temp_blks_written FROM pg_stat_statements(false) WHERE dbid = (SELECT oid FROM pg_database WHERE datname=current_database())",
                  )
                )[0];
              phase = `PostgreSQL ${major} ${scenario} counters`;
              let statementCount = 0;
              let measuring = false;
              workload = postgres(uri, {
                max: 1,
                onnotice: () => {},
                connection: {
                  application_name:
                    index === 0 ? "openmapx-replay-baseline" : "openmapx-replay-candidate",
                },
                debug: () => {
                  if (measuring) statementCount++;
                },
              });
              await workload.unsafe(
                `SET search_path = replay_clock, pg_catalog, public; SET replay.now = '${t1}'`,
              );
              const [clock] = await workload.unsafe("SELECT now()::text AS value");
              if (new Date(clock.value).toISOString() !== t1) {
                await workload.end();
                throw new Error("Workload clock differs");
              }
              const runtimeBefore = await sampleRuntime();
              const before = await counters(),
                statementsBefore = await statementCounters();
              let wallMs = 0;
              measuring = true;
              phase = `PostgreSQL ${major} ${scenario} workload`;
              const started = performance.now();
              try {
                if (scenario === "first-register-linking") {
                  const written = await storage.writeSnapshot(
                    workload,
                    "replay-national",
                    { features: national },
                    context(t1),
                  );
                  if (written.rejected.length) throw new Error("Register fixture rejected");
                } else if (scenario === "observation-only")
                  await write(
                    workload,
                    {
                      features: [],
                      situations: [],
                      offers: [],
                      observations: [
                        drafts.observationDraft(
                          "traffic.speed",
                          { type: "quantity", value: 80, unit: "km/h" },
                          { at: t1 },
                        ),
                      ],
                    },
                    t1,
                  );
                else if (scenario === "complete-empty")
                  await write(workload, { features: [] }, t1, true);
                else if (scenario === "changed")
                  await write(
                    workload,
                    {
                      features: [
                        drafts.featureDraft("s1", 4, { lifecycle: "planned" }),
                        ...features.slice(1),
                      ],
                    },
                    t1,
                  );
                else if (scenario === "expiry-only")
                  await write(
                    workload,
                    {
                      features: features.map((feature) => ({
                        ...feature,
                        freshness: {
                          fetchedAt: "2026-10-01T10:00:00.000Z",
                          expiresAt: "2026-10-02T10:00:00.000Z",
                        },
                      })),
                    },
                    t1,
                  );
                else {
                  await write(workload, { features }, t1);
                  if (scenario === "initial") await seedOtherClasses(workload, t1);
                }
              } finally {
                wallMs = performance.now() - started;
                measuring = false;
                try {
                  await workload.unsafe("SELECT pg_stat_force_next_flush()");
                } finally {
                  await workload.end();
                  workload = undefined;
                }
              }
              await new Promise((done) => setTimeout(done, 1100));
              const after = await counters(),
                statementsAfter = await statementCounters();
              const delta = counterDelta(before, after);
              const sum = (suffix: string) =>
                Object.entries(delta)
                  .filter(([key]) => key.endsWith(suffix))
                  .reduce((total, [, value]) => total + BigInt(value), 0n);
              const hotUpdates = sum(".n_tup_hot_upd"),
                updates = sum(".n_tup_upd");
              phase = `PostgreSQL ${major} ${scenario} logical comparison`;
              if (scenario === "first-register-linking") {
                const [linked] = await sql.unsafe(
                  "SELECT count(*)::int AS count FROM conditions.feature_canonical WHERE cardinality(member_ids) = 2",
                );
                if (linked.count !== regional.length)
                  throw new Error("Register fixture did not form the expected paired clusters");
              }
              const logical: Record<string, unknown> = {};
              const tableNames = await sql.unsafe(
                "SELECT tablename FROM pg_tables WHERE schemaname='conditions' AND tablename NOT LIKE '%migration%' ORDER BY tablename",
              );
              for (const { tablename } of tableNames) {
                if (!/^[a-z_0-9]+$/.test(tablename)) throw new Error("Unexpected table identifier");
                logical[tablename] = await sql.unsafe(
                  `SELECT to_jsonb(t) AS row FROM conditions."${tablename}" t ORDER BY to_jsonb(t)::text`,
                );
              }
              pair[index] = {
                logical,
                result: {
                  major,
                  image: images[major],
                  version,
                  scenario,
                  run,
                  arm: index === 0 ? "baseline" : "candidate",
                  order,
                  wallMs,
                  statementCount,
                  before,
                  after,
                  delta,
                  statementDelta: counterDelta(
                    { reset: before.reset, values: statementsBefore },
                    { reset: after.reset, values: statementsAfter },
                  ),
                  harnessRssBytes: process.memoryUsage().rss,
                  runtimeBefore,
                  runtimeAfter: await sampleRuntime(),
                  hot: {
                    numerator: hotUpdates.toString(),
                    denominator: updates.toString(),
                    ratio: updates ? Number(hotUpdates) / Number(updates) : null,
                  },
                  inputHash: digest({ scenario, features, regional, national }),
                  logicalHash: digest(logical),
                  exactRows: Object.fromEntries(
                    Object.entries(logical).map(([table, rows]) => [
                      table,
                      (rows as unknown[]).length,
                    ]),
                  ),
                },
              };
            } finally {
              try {
                await workload?.end({ timeout: 2 });
                await sql?.end({ timeout: 2 });
              } finally {
                await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
              }
            }
          }
          if (pair[0].result.inputHash !== pair[1].result.inputHash)
            throw new Error("Replay input identity differs");
          const correctness = comparePair(
            {
              revision: identities[0].revision,
              fixtureHash: implementations[0].fixtureHash,
              inputHash: String(pair[0].result.inputHash),
              logical: pair[0].logical,
            },
            {
              revision: identities[1].revision,
              fixtureHash: implementations[1].fixtureHash,
              inputHash: String(pair[1].result.inputHash),
              logical: pair[1].logical,
            },
          );
          results.push({ ...pair[0].result, correctness }, { ...pair[1].result, correctness });
          invocation.writeRuns({ ...report, results });
          if (!correctness.equal)
            throw new Error(
              `Logical output differs for PostgreSQL ${major}/${scenario}; hashes recorded`,
            );
          process.stdout.write(
            `PostgreSQL ${major} ${scenario} repetition ${run + 1}/${options.runs}: equal\n`,
          );
        }
      }
    } finally {
      try {
        await admin.end({ timeout: 2 });
      } finally {
        await container.stop();
      }
    }
  }
  for (const [index, identity] of identities.entries()) {
    if (digest(artifactHashes(identity.path)) !== digest(builds[index].artifacts))
      throw new Error("Built artifacts changed during replay");
    if (identifyWorktree(identity.path).revision !== identity.revision)
      throw new Error("OC revision changed during replay");
  }
  const groups = new Map<string, number[]>();
  for (const result of results) {
    const key = `${result.major}/${result.scenario}/${result.arm}`;
    const metrics = {
      wallMs: result.wallMs,
      statementCount: result.statementCount,
      harnessRssBytes: result.harnessRssBytes,
      ...(result.delta as Record<string, string>),
      ...(result.statementDelta as Record<string, string>),
    };
    for (const [metric, value] of Object.entries(metrics)) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER)
        throw new Error("Metric exceeds safe summary precision; raw samples retained");
      const group = `${key}/${metric}`;
      groups.set(group, [...(groups.get(group) ?? []), numeric]);
    }
  }
  return {
    runs: { ...report, results },
    summary: {
      ...report,
      correctness: { equal: true, differences: 0 },
      decision: "INCONCLUSIVE: synthetic fixture; inspect variance and native acceptance gates",
      metrics: Object.fromEntries([...groups].map(([key, values]) => [key, summarize(values)])),
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch(() => {
    console.error(
      `Replay failed during ${phase}; connection details and record payloads are withheld.`,
    );
    process.exitCode = 1;
  });
