import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ControlInstallation,
  type ControlRetentionPreparationContext,
  controlDigest,
  controlInstallationDataRoot,
  controlRetentionPreparationState,
  readVerifiedStagedCoordinatorOwnership,
  type VerifiedCoordinatorPullBaseline,
  type VerifiedStagedCoordinatorOwnerBaseline,
  type VerifiedStagedCoordinatorOwnership,
  verifiedCoordinatorPullBaselineState,
  verifiedStagedCoordinatorOwnerBaselineState,
  verifiedStagedCoordinatorOwnershipState,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  type ExecutionRef,
  type OpsOperation,
  opsOperationFingerprint,
  parseOpsJobStatus,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type { DockerRuntimeOptions } from "./docker-runtime";
import {
  type OpsJobJournal,
  type PersistedOpsJob,
  readProductionCoordinatorJournalIndex,
} from "./journal";
import type { OpsTrustedClaim } from "./runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";

export interface OwnedServiceSnapshot {
  serviceId: string;
  containerId: string;
  state: "running" | "stopped" | "created" | "restarting" | "paused" | "unknown";
  provenance: {
    project: string;
    composeWorkingDirectory: string;
    composeConfigFiles: string[];
    imageId: string;
  };
}
/** Docker-host metadata provenance; it does not authenticate a hostile Docker administrator. */
export interface OwnedServiceInventory {
  services: OwnedServiceSnapshot[];
  /** Retention-only observations, never authorization claims. */
  observedContainerIds: string[];
  /** Registered candidates whose provenance could not be verified; denial only. */
  unverifiedServiceIds: string[];
}
export interface OwnedServiceResolver {
  inspectOwnedServices(signal: AbortSignal): Promise<OwnedServiceSnapshot[]>;
  inspectInventory?(signal: AbortSignal): Promise<OwnedServiceInventory>;
}
declare const captureBrand: unique symbol;
export type CoordinatorPullOwnershipCapture = Readonly<{ [captureBrand]: true }>;
export interface CoordinatorPullOwnershipObservation {
  operationFingerprint: string;
  candidateId: string;
  configurationAuthorityRevision: string;
  policyRevision: string;
  observedAt: number;
  configImageReference: string;
  composeSourcesDigest: string;
  container: OwnedServiceSnapshot;
}
const literalCaptures = new WeakMap<
  OwnedServiceResolver,
  (
    operation: Extract<OpsOperation, { kind: "service.pull" }>,
    fingerprint: string,
    revisions: { configurationAuthorityRevision: string; policyRevision: string },
    signal: AbortSignal,
  ) => Promise<CoordinatorPullOwnershipObservation>
>();
const captures = new WeakMap<
  CoordinatorPullOwnershipCapture,
  CoordinatorPullOwnershipObservation
>();
const attached = new WeakSet<CoordinatorPullOwnershipCapture>();
const claimCaptures = new WeakMap<OpsTrustedClaim, CoordinatorPullOwnershipCapture>();
const originalInspectors = new WeakMap<
  OwnedServiceResolver,
  (proof: VerifiedCoordinatorPullBaseline, signal: AbortSignal) => Promise<OwnedServiceSnapshot[]>
>();
const stagedMaintenanceInspectors = new WeakMap<
  OwnedServiceResolver,
  (
    signal: AbortSignal,
  ) => Promise<{ services: OwnedServiceSnapshot[]; proof?: VerifiedStagedCoordinatorOwnership }>
>();
const stagedOwnerInspectors = new WeakMap<
  OwnedServiceResolver,
  (
    proof: VerifiedStagedCoordinatorOwnerBaseline,
    signal: AbortSignal,
  ) => Promise<OwnedServiceSnapshot[]>
>();
export function inspectStagedCoordinatorMaintenanceSource(
  resolver: OwnedServiceResolver,
  signal: AbortSignal,
) {
  const inspect = stagedMaintenanceInspectors.get(resolver);
  if (!inspect) throw Error(FAILED);
  return inspect(signal);
}
export function inspectStagedCoordinatorOwnerServices(
  resolver: OwnedServiceResolver,
  proof: VerifiedStagedCoordinatorOwnerBaseline,
  signal: AbortSignal,
) {
  const inspect = stagedOwnerInspectors.get(resolver);
  if (!inspect) throw Error(FAILED);
  return inspect(proof, signal);
}
const literalRoots = new WeakMap<OwnedServiceResolver, string>();
const stagedSources = new WeakMap<
  OwnedServiceResolver,
  { installation: ControlInstallation; journal: OpsJobJournal }
>();
/** Only fixed startup can bind a real journal and installation to a literal resolver. */
export function bindCoordinatorStagedOwnershipSource(
  resolver: OwnedServiceResolver,
  installation: ControlInstallation,
  journal: OpsJobJournal,
): void {
  const infra = literalRoots.get(resolver);
  if (
    !infra ||
    installation.role !== "ops-agent" ||
    stagedSources.has(resolver) ||
    realpathSync(controlInstallationDataRoot(installation)) !== join(infra, "data")
  )
    throw Error(FAILED);
  readProductionCoordinatorJournalIndex(journal, controlInstallationDataRoot(installation));
  stagedSources.set(resolver, { installation, journal });
}
function stagedProofForJob(
  installation: ControlInstallation,
  job: PersistedOpsJob,
  context?: ControlRetentionPreparationContext,
) {
  const status = parseOpsJobStatus({
    version: 2,
    admittedAt: job.admittedAt,
    deadlineAt: job.deadlineAt,
    fingerprint: job.fingerprint,
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: job.operation.kind,
    resourceId: job.resourceId,
    state: job.state,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    result: job.result,
    ...(job.terminationRequestedAt ? { terminationRequestedAt: job.terminationRequestedAt } : {}),
  });
  const execution: ExecutionRef = {
    executor: "ops-agent",
    principal: "api",
    executionId: job.operationId,
    operationKey: job.operationKey,
    operationFingerprint: job.operationFingerprint!,
    fingerprint: job.fingerprint,
    deadlineAt: job.deadlineAt!,
  };
  return readVerifiedStagedCoordinatorOwnership(installation, execution, status, context);
}
const stagedRetentionInspectors = new WeakMap<
  OwnedServiceResolver,
  (
    proof: VerifiedStagedCoordinatorOwnership,
    signal: AbortSignal,
  ) => Promise<"needed" | "not-needed">
>();
const stagedConfigurationInspectors = new WeakMap<
  OwnedServiceResolver,
  (signal: AbortSignal) => Promise<"none" | "required" | "unknown">
>();
/** Actual literal Docker/cache/source observation. No structural resolver or
 * caller-supplied absence flag can qualify a managed configuration write. */
export async function inspectLiteralStagedConfigurationDependency(
  resolver: OwnedServiceResolver,
  signal: AbortSignal,
) {
  const inspect = stagedConfigurationInspectors.get(resolver);
  if (!inspect) throw Error(FAILED);
  return inspect(signal);
}
const oldStagedDigest = (
  baseline: import("@openmapx/core/build-artifacts").CoordinatorPullBaseline,
) =>
  controlDigest({
    container: baseline.container,
    configImageReference: baseline.configImageReference,
    composeSourcesDigest: baseline.composeSourcesDigest,
    configurationRevisionId: baseline.configurationRevisionId,
  });
export async function readLiteralCoordinatorStagedRetention(
  resolver: OwnedServiceResolver,
  installation: ControlInstallation,
  journal: OpsJobJournal,
  context: ControlRetentionPreparationContext,
) {
  const bound = stagedSources.get(resolver),
    state = controlRetentionPreparationState(context);
  if (
    !bound ||
    bound.installation !== installation ||
    bound.journal !== journal ||
    state.installationId !== installation.installationId ||
    state.role !== "ops-agent"
  )
    throw Error(FAILED);
  if (state.mode === "committed-cleanup") return undefined;
  const records = readProductionCoordinatorJournalIndex(
    journal,
    controlInstallationDataRoot(installation),
  );
  let result:
    | {
        source: ReturnType<typeof verifiedStagedCoordinatorOwnershipState>["source"];
        condition: "not-needed" | "higher-ranked-successor";
        successor: ReturnType<typeof verifiedStagedCoordinatorOwnershipState>["source"] | null;
        oldContainerDigest: string;
      }
    | undefined;
  for (const fact of state.executions) {
    const job = records.find(
      (job) =>
        job.operationId === fact.execution.executionId &&
        job.operationKey === fact.execution.operationKey,
    );
    if (!job) {
      if (fact.requiresJournal) throw Error("Actual retiring journal member required");
      continue;
    }
    if (
      job.operation.kind !== "service.pull" ||
      job.operation.serviceId !== "data-manager" ||
      !job.operation.candidateId ||
      job.executionVersion !== 2 ||
      job.requestVersion !== 2 ||
      job.state !== "succeeded"
    )
      continue;
    if (result) throw Error("Ambiguous staged retirement source family");
    const proof = stagedProofForJob(installation, job, context),
      source = verifiedStagedCoordinatorOwnershipState(proof).source;
    const inspect = stagedRetentionInspectors.get(resolver);
    if (!inspect) throw Error(FAILED);
    const need = await inspect(proof, AbortSignal.timeout(15000)),
      oldContainerDigest = oldStagedDigest(source.baseline);
    if (need === "not-needed") {
      result = { source, condition: "not-needed", successor: null, oldContainerDigest };
      continue;
    }
    const successor = stagedProofs(resolver)
      .map((value) => verifiedStagedCoordinatorOwnershipState(value).source)
      .find(
        (value) =>
          value.execution.operationKey !== source.execution.operationKey &&
          (value.admittedAt > source.admittedAt ||
            (value.admittedAt === source.admittedAt &&
              value.execution.operationKey > source.execution.operationKey)) &&
          oldStagedDigest(value.baseline) === oldContainerDigest,
      );
    if (!successor) throw Error("Last staged coordinator source remains required");
    result = { source, condition: "higher-ranked-successor", successor, oldContainerDigest };
  }
  return result;
}
function stagedProofs(resolver: OwnedServiceResolver): VerifiedStagedCoordinatorOwnership[] {
  const source = stagedSources.get(resolver);
  if (!source) return [];
  const records = readProductionCoordinatorJournalIndex(
    source.journal,
    controlInstallationDataRoot(source.installation),
  );
  const proofs: VerifiedStagedCoordinatorOwnership[] = [];
  for (const job of records) {
    if (
      job.role !== "api" ||
      job.operation.kind !== "service.pull" ||
      job.operation.serviceId !== "data-manager" ||
      !job.operation.candidateId ||
      job.executionVersion !== 2 ||
      job.requestVersion !== 2 ||
      job.state !== "succeeded"
    )
      continue;
    try {
      proofs.push(stagedProofForJob(source.installation, job));
    } catch {
      /* An ineligible journal locator cannot authenticate provenance. */
    }
  }
  return proofs.sort((a, b) => {
    const x = verifiedStagedCoordinatorOwnershipState(a).source,
      y = verifiedStagedCoordinatorOwnershipState(b).source;
    return (
      y.admittedAt - x.admittedAt ||
      (x.execution.operationKey < y.execution.operationKey
        ? 1
        : x.execution.operationKey > y.execution.operationKey
          ? -1
          : 0)
    );
  });
}
export async function captureCoordinatorPullOwnership(
  resolver: OwnedServiceResolver,
  operation: OpsOperation,
  fingerprint: string,
  revisions: { configurationAuthorityRevision: string; policyRevision: string },
  signal: AbortSignal,
): Promise<CoordinatorPullOwnershipCapture> {
  const capture = literalCaptures.get(resolver);
  if (
    !capture ||
    operation.kind !== "service.pull" ||
    operation.serviceId !== "data-manager" ||
    !operation.candidateId ||
    opsOperationFingerprint(operation) !== fingerprint ||
    !revisions.configurationAuthorityRevision ||
    !revisions.policyRevision
  )
    throw Error(FAILED);
  const observation = await capture(operation, fingerprint, revisions, signal);
  const token = Object.freeze({}) as CoordinatorPullOwnershipCapture;
  captures.set(token, observation);
  return token;
}
function matchingClaim(claim: OpsTrustedClaim, value: CoordinatorPullOwnershipObservation) {
  return (
    claim.source === "registry" &&
    claim.operation.kind === "service.pull" &&
    claim.operation.serviceId === "data-manager" &&
    claim.operation.candidateId === value.candidateId &&
    claim.fingerprint === value.operationFingerprint &&
    opsOperationFingerprint(claim.operation as OpsOperation) === value.operationFingerprint &&
    claim.capability.revisionId === value.policyRevision &&
    claim.capability.values.ownedService === JSON.stringify(value.container)
  );
}
export function attachCoordinatorPullOwnershipCapture(
  claim: OpsTrustedClaim,
  capture: CoordinatorPullOwnershipCapture,
): void {
  const value = captures.get(capture);
  if (!value || attached.has(capture) || claimCaptures.has(claim) || !matchingClaim(claim, value))
    throw Error(FAILED);
  attached.add(capture);
  claimCaptures.set(claim, capture);
}
export function consumeCoordinatorPullOwnershipCapture(
  claim: OpsTrustedClaim,
  expected: { operationFingerprint: string; candidateId: string; policyRevision: string },
): CoordinatorPullOwnershipObservation {
  const token = claimCaptures.get(claim);
  claimCaptures.delete(claim);
  const value = token && captures.get(token);
  if (token) captures.delete(token);
  if (
    !value ||
    !matchingClaim(claim, value) ||
    value.operationFingerprint !== expected.operationFingerprint ||
    value.candidateId !== expected.candidateId ||
    value.policyRevision !== expected.policyRevision
  )
    throw Error(FAILED);
  return value;
}
/** No caller-supplied image or snapshot enters the private literal inspector. */
export async function inspectOriginalCoordinatorServices(
  resolver: OwnedServiceResolver,
  proof: VerifiedCoordinatorPullBaseline,
  signal: AbortSignal,
): Promise<OwnedServiceSnapshot[]> {
  const inspect = originalInspectors.get(resolver);
  if (!inspect) throw Error(FAILED);
  return inspect(proof, signal);
}
/** Actual ordered, bounded FD bytes and identity, never retained contents. */
function composeSourcesDigest(files: readonly string[]): string {
  if (files.length < 1 || files.length > 2) throw Error(FAILED);
  const tuples = files.map((path) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true }),
        current = lstatSync(path, { bigint: true });
      const same = (a: typeof before, b: typeof before) =>
        ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
          (key) => a[key as keyof typeof a] === b[key as keyof typeof b],
        );
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(process.geteuid?.() ?? 0) ||
        (before.mode & 0o022n) !== 0n ||
        before.size > 1048576n ||
        !same(before, current)
      )
        throw Error(FAILED);
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, null);
        if (!count) break;
        used += count;
      }
      if (
        BigInt(used) !== before.size ||
        !same(before, fstatSync(fd, { bigint: true })) ||
        !same(before, lstatSync(path, { bigint: true }))
      )
        throw Error(FAILED);
      return {
        path,
        dev: String(before.dev),
        ino: String(before.ino),
        uid: String(before.uid),
        mode: String(before.mode),
        nlink: String(before.nlink),
        size: String(before.size),
        mtimeNs: String(before.mtimeNs),
        ctimeNs: String(before.ctimeNs),
        sha256Bytes: createHash("sha256").update(bytes.subarray(0, used)).digest("hex"),
      };
    } finally {
      closeSync(fd);
    }
  });
  return createHash("sha256")
    .update("openmapx-coordinator-pull-compose-baseline-v1\0")
    .update(canonicalJson(tuples))
    .digest("hex");
}
const FAILED = "Owned service inventory unavailable";
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const FORMAT =
  '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{{json .State.Status}},"ConfigImage":{{json .Config.Image}},"Labels":{{json .Config.Labels}}}';

export function createOwnedServiceResolver(options: {
  stack: services.StackPaths;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
}): OwnedServiceResolver {
  const inspectInventory = async (
    signal: AbortSignal,
    original?: {
      baseline: import("@openmapx/core/build-artifacts").CoordinatorPullBaseline;
      expectedCurrentRevisionId: string;
      currentAuthorityRevision: string;
    },
    captured?: {
      revision?: string;
      observations: Map<string, { reference: string; digest: string }>;
    },
    stagedObservation?: { proof?: VerifiedStagedCoordinatorOwnership },
    cacheOnly = false,
  ): Promise<OwnedServiceInventory & { coordinatorObserved: number }> => {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const run = async (args: string[]) => {
      signal.throwIfAborted();
      const result = await options.execFile("docker", args, {
        signal,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      signal.throwIfAborted();
      if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error(FAILED);
      return result.stdout;
    };
    try {
      const authority = await options.loadAuthority();
      if (captured) captured.revision = authority.revisionId;
      if (
        original &&
        (original.currentAuthorityRevision !== authority.revisionId ||
          services.currentConfigurationGeneration(options.stack.infraDir) !==
            original.expectedCurrentRevisionId)
      )
        throw Error(FAILED);
      if (
        authority.services.length > 256 ||
        new Set(authority.services.map((s) => s.manifest.id)).size !== authority.services.length
      )
        throw new Error(FAILED);
      const registry = new Map(authority.services.map((s) => [s.manifest.id, s]));
      const listing = (
        await run([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `label=com.docker.compose.project=${services.STACK_PROJECT}`,
          "--format",
          "{{.ID}}",
        ])
      ).trim();
      const ids = listing ? listing.split(/\r?\n/) : [];
      if (ids.length > 256 || ids.some((id) => !ID.test(id)) || new Set(ids).size !== ids.length)
        throw new Error(FAILED);
      if (!ids.length)
        return {
          services: [],
          observedContainerIds: [],
          unverifiedServiceIds: [],
          coordinatorObserved: 0,
        };
      const rows = (await run(["container", "inspect", "--format", FORMAT, ...ids]))
        .trim()
        .split(/\r?\n/);
      if (rows.length !== ids.length) throw new Error(FAILED);
      const infra = realpathSync(options.stack.infraDir);
      const configuredInfra = resolve(options.stack.infraDir);
      const canonical = (path: string): string => {
        if (![infra, configuredInfra].some((root) => path === root || path.startsWith(`${root}/`)))
          throw new Error(FAILED);
        if (!path.startsWith("/") || path !== resolve(path) || /[\0\r\n]/.test(path))
          throw new Error(FAILED);
        return realpathSync(path);
      };
      const found: OwnedServiceSnapshot[] = [];
      const candidates = new Set<string>();
      const images = new Map<string, string>();
      const configurations = new Map<string, Record<string, { image?: string }>>();
      let coordinatorObserved = 0;
      for (let index = 0; index < rows.length; index++) {
        const row = JSON.parse(rows[index] ?? "") as Record<string, unknown>;
        if (
          row.Id !== ids[index] ||
          typeof row.Image !== "string" ||
          !IMAGE.test(row.Image) ||
          typeof row.State !== "string" ||
          typeof row.ConfigImage !== "string" ||
          !row.Labels ||
          typeof row.Labels !== "object" ||
          Array.isArray(row.Labels)
        )
          throw new Error(FAILED);
        const labels = row.Labels as Record<string, unknown>;
        const serviceId = labels["com.docker.compose.service"];
        if (
          labels["com.docker.compose.project"] === services.STACK_PROJECT &&
          serviceId === "data-manager"
        )
          coordinatorObserved++;
        if (
          labels["com.docker.compose.project"] !== services.STACK_PROJECT ||
          typeof serviceId !== "string" ||
          !registry.has(serviceId)
        )
          continue;
        // The installed staged source must never choose between registered
        // DM rows, including a row whose paths or image cannot be verified.
        if (
          serviceId === "data-manager" &&
          stagedSources.has(resolver) &&
          candidates.has(serviceId)
        )
          throw Error(FAILED);
        candidates.add(serviceId);
        const working = labels["com.docker.compose.project.working_dir"];
        const files = labels["com.docker.compose.project.config_files"];
        if (typeof working !== "string" || typeof files !== "string" || files.length > 8192)
          continue;
        let configFiles: string[], workingDirectory: string;
        try {
          configFiles = files.split(",").map(canonical);
          workingDirectory = canonical(working);
          const legacyCurrentFiles = [infra, configuredInfra].map((root) =>
            join(root, services.CURRENT_CONFIGURATION, services.GENERATED_COMPOSE_FILE),
          );
          if (legacyCurrentFiles.includes(files.split(",")[0] ?? "")) {
            const retained = services.retainedContainerComposeFile(infra, row.Id as string);
            if (retained) {
              configFiles[0] = retained;
              if (
                [infra, configuredInfra].some(
                  (root) => working === join(root, services.CURRENT_CONFIGURATION),
                )
              )
                workingDirectory = dirname(retained);
            }
          }
        } catch {
          continue;
        }
        const first = configFiles[0];
        const generation = first?.slice(`${infra}/${services.CONFIGURATION_GENERATIONS}/`.length);
        const generationFile =
          first?.startsWith(`${infra}/${services.CONFIGURATION_GENERATIONS}/`) &&
          /^cfg1_[A-Za-z0-9_-]{43}\/docker-compose.generated.yml$/.test(generation ?? "");
        if (
          !first ||
          (!generationFile && first !== join(infra, services.GENERATED_COMPOSE_FILE)) ||
          ![infra, dirname(first)].includes(workingDirectory) ||
          configFiles.length > 2 ||
          new Set(configFiles).size !== configFiles.length ||
          (configFiles[1] !== undefined &&
            (configFiles[1] !== services.releaseStatePaths(infra).overlay ||
              configFiles[1] !== canonical(options.stack.composeReleasePath)))
        )
          continue;
        try {
          if (generationFile)
            services.configurationGenerationComposeFile(
              infra,
              dirname(first).split("/").at(-1) ?? "",
            );
          for (const file of configFiles) {
            const stat = lstatSync(file);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.uid !== (process.geteuid?.() ?? 0) ||
              (stat.mode & 0o022) !== 0 ||
              stat.nlink !== 1
            )
              throw new Error(FAILED);
          }
        } catch {
          continue;
        }
        const digestBefore =
          captured || original || (serviceId === "data-manager" && stagedSources.has(resolver))
            ? composeSourcesDigest(configFiles)
            : undefined;
        const key = JSON.stringify(configFiles);
        let configuration = configurations.get(key);
        if (!configuration) {
          const releasePath = services.releaseStatePaths(infra).overlay;
          const args = services.stackComposeArgs(
            { infraDir: infra, composePath: first, composeReleasePath: releasePath },
            (path) => (path === releasePath ? configFiles.includes(releasePath) : existsSync(path)),
          );
          if (!args.includes("--project-name"))
            args.splice(1, 0, "--project-name", services.STACK_PROJECT);
          const config = JSON.parse(await run([...args, "config", "--format", "json"])) as {
            services?: Record<string, { image?: string }>;
          };
          if (
            !config.services ||
            typeof config.services !== "object" ||
            Array.isArray(config.services) ||
            Object.keys(config.services).length > 256 ||
            Object.values(config.services).some(
              (entry) =>
                !entry ||
                typeof entry !== "object" ||
                Array.isArray(entry) ||
                (entry.image !== undefined && typeof entry.image !== "string"),
            )
          )
            throw new Error(FAILED);
          configuration = config.services;
          configurations.set(key, configuration);
        }
        // Deselection removes Compose membership, but the registered manifest
        // remains authority for its effective image. Release overlays still win
        // when they provide an explicit image for that service.
        const registered = registry.get(serviceId);
        const reference =
          configuration[serviceId]?.image ??
          (registered
            ? services.serviceContainerImageReference(registered.manifest.container)
            : undefined);
        if (
          !reference ||
          row.ConfigImage !== reference ||
          reference.length > 512 ||
          /[\0\r\n]/.test(reference)
        )
          continue;
        let imageId = images.get(reference);
        if (!imageId) {
          imageId = (await run(["image", "inspect", "--format", "{{.Id}}", reference])).trim();
          if (!IMAGE.test(imageId)) throw new Error(FAILED);
          images.set(reference, imageId);
        }
        if (digestBefore && composeSourcesDigest(configFiles) !== digestBefore) throw Error(FAILED);
        if (original && serviceId === "data-manager") {
          const baseline = original.baseline;
          if (
            row.Id !== baseline.container.containerId ||
            reference !== baseline.configImageReference ||
            digestBefore !== baseline.composeSourcesDigest ||
            row.Image !== baseline.container.provenance.imageId ||
            workingDirectory !== baseline.container.provenance.composeWorkingDirectory ||
            canonicalJson(configFiles) !==
              canonicalJson(baseline.container.provenance.composeConfigFiles)
          )
            throw Error(FAILED);
          imageId = baseline.container.provenance.imageId;
        }
        if (row.Image !== imageId && serviceId === "data-manager" && !original && !cacheOnly) {
          const current = services.currentConfigurationGeneration(options.stack.infraDir);
          for (const proof of stagedProofs(resolver)) {
            const baseline = verifiedStagedCoordinatorOwnershipState(proof).source.baseline;
            if (
              current === baseline.configurationRevisionId &&
              row.Id === baseline.container.containerId &&
              reference === baseline.configImageReference &&
              digestBefore === baseline.composeSourcesDigest &&
              row.Image === baseline.container.provenance.imageId &&
              workingDirectory === baseline.container.provenance.composeWorkingDirectory &&
              canonicalJson(configFiles) ===
                canonicalJson(baseline.container.provenance.composeConfigFiles)
            ) {
              imageId = baseline.container.provenance.imageId;
              if (stagedObservation) stagedObservation.proof = proof;
              break;
            }
          }
        }
        if (row.Image !== imageId) continue;
        captured?.observations.set(serviceId, { reference, digest: digestBefore! });
        if (found.some((entry) => entry.serviceId === serviceId)) throw new Error(FAILED);
        found.push({
          serviceId,
          containerId: row.Id as string,
          state:
            row.State === "exited" || row.State === "dead"
              ? "stopped"
              : ["running", "stopped", "created", "restarting", "paused"].includes(row.State)
                ? (row.State as OwnedServiceSnapshot["state"])
                : "unknown",
          provenance: {
            project: services.STACK_PROJECT,
            composeWorkingDirectory: workingDirectory,
            composeConfigFiles: configFiles,
            imageId,
          },
        });
      }
      return {
        services: found,
        observedContainerIds: ids,
        unverifiedServiceIds: [...candidates].filter(
          (id) => !found.some((service) => service.serviceId === id),
        ),
        coordinatorObserved,
      };
    } catch {
      throw new Error(FAILED);
    }
  };
  const resolver: OwnedServiceResolver = {
    inspectInventory: async (signal) => {
      const { coordinatorObserved: _privateCount, ...inventory } = await inspectInventory(signal);
      return inventory;
    },
    inspectOwnedServices: async (signal) => (await inspectInventory(signal)).services,
  };
  literalRoots.set(resolver, realpathSync(options.stack.infraDir));
  literalCaptures.set(resolver, async (operation, fingerprint, revisions, signal) => {
    const captured = {
      revision: undefined as string | undefined,
      observations: new Map<string, { reference: string; digest: string }>(),
    };
    const inventory = await inspectInventory(signal, undefined, captured),
      container = inventory.services.find((s) => s.serviceId === "data-manager"),
      observation = captured.observations.get("data-manager");
    if (
      !container ||
      container.state !== "running" ||
      !observation ||
      captured.revision !== revisions.configurationAuthorityRevision ||
      (await options.loadAuthority()).revisionId !== revisions.configurationAuthorityRevision ||
      services.currentConfigurationGeneration(options.stack.infraDir) !==
        operation.expectedConfigurationRevisionId
    )
      throw Error(FAILED);
    Object.freeze(container.provenance.composeConfigFiles);
    Object.freeze(container.provenance);
    Object.freeze(container);
    return Object.freeze({
      operationFingerprint: fingerprint,
      candidateId: operation.candidateId!,
      ...revisions,
      observedAt: Date.now(),
      configImageReference: observation.reference,
      composeSourcesDigest: observation.digest,
      container,
    });
  });
  originalInspectors.set(resolver, async (proof, signal) => {
    const original = verifiedCoordinatorPullBaselineState(proof),
      result = await inspectInventory(signal, {
        ...original,
        currentAuthorityRevision: original.baseline.configurationAuthorityRevision,
      });
    if (
      canonicalJson(result.services.find((s) => s.serviceId === "data-manager")) !==
      canonicalJson(original.baseline.container)
    )
      throw Error(FAILED);
    return result.services;
  });
  stagedMaintenanceInspectors.set(resolver, async (signal) => {
    const observation: { proof?: VerifiedStagedCoordinatorOwnership } = {};
    const result = await inspectInventory(signal, undefined, undefined, observation);
    return {
      services: result.services,
      ...(observation.proof ? { proof: observation.proof } : {}),
    };
  });
  stagedConfigurationInspectors.set(resolver, async (signal) => {
    try {
      const ordinary = await inspectInventory(signal, undefined, undefined, undefined, true);
      if (ordinary.coordinatorObserved > 1) return "unknown";
      if (ordinary.services.some((service) => service.serviceId === "data-manager")) return "none";
      if (ordinary.coordinatorObserved === 0) return "none";
      const observed: { proof?: VerifiedStagedCoordinatorOwnership } = {};
      const actual = await inspectInventory(signal, undefined, undefined, observed);
      return observed.proof &&
        actual.services.some((service) => service.serviceId === "data-manager")
        ? "required"
        : "unknown";
    } catch {
      return "unknown";
    }
  });
  stagedOwnerInspectors.set(resolver, async (proof, signal) => {
    const original = verifiedStagedCoordinatorOwnerBaselineState(proof);
    services.configurationGenerationComposeFile(
      options.stack.infraDir,
      original.expectedCurrentRevisionId,
    );
    const result = await inspectInventory(signal, original);
    const actual = result.services.find((s) => s.serviceId === "data-manager"),
      old = original.baseline.container;
    if (!actual || canonicalJson({ ...actual, state: old.state }) !== canonicalJson(old))
      throw Error(FAILED);
    return result.services;
  });
  stagedRetentionInspectors.set(resolver, async (proof, signal) => {
    const source = verifiedStagedCoordinatorOwnershipState(proof),
      baseline = source.source.baseline;
    const ordinary = await inspectInventory(signal, undefined, undefined, undefined, true),
      dm = ordinary.services.find((s) => s.serviceId === "data-manager");
    if (dm) return "not-needed";
    if (
      !ordinary.observedContainerIds.includes(baseline.container.containerId) &&
      !ordinary.unverifiedServiceIds.includes("data-manager")
    )
      return "not-needed";
    const current = services.currentConfigurationGeneration(options.stack.infraDir),
      authority = await options.loadAuthority();
    if (!current) throw Error(FAILED);
    const actual = await inspectInventory(
      signal,
      {
        baseline,
        expectedCurrentRevisionId: current,
        currentAuthorityRevision: authority.revisionId,
      },
      undefined,
      undefined,
      true,
    );
    const old = actual.services.find((s) => s.serviceId === "data-manager");
    if (
      !old ||
      canonicalJson({ ...old, state: baseline.container.state }) !==
        canonicalJson(baseline.container)
    )
      throw Error(FAILED);
    return "needed";
  });
  return resolver;
}

export async function confirmCoordinatorPullOwnership(
  resolver: OwnedServiceResolver,
  operation: OpsOperation,
  fingerprint: string,
  baseline: import("@openmapx/core/build-artifacts").CoordinatorPullBaseline,
  signal: AbortSignal,
): Promise<void> {
  const capture = literalCaptures.get(resolver);
  if (!capture || operation.kind !== "service.pull") throw Error(FAILED);
  const value = await capture(operation, fingerprint, baseline, signal);
  if (
    canonicalJson(value.container) !== canonicalJson(baseline.container) ||
    value.configImageReference !== baseline.configImageReference ||
    value.composeSourcesDigest !== baseline.composeSourcesDigest
  )
    throw Error(FAILED);
}
