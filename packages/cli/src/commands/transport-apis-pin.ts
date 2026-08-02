import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { execa } from "execa";
import { parseEntry } from "../../../../integrations/transit-dynamic-registry/fetcher";
import { registryEndpointRejection } from "../../../../integrations/transit-dynamic-registry/validate-endpoint";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const TRANSPORT_APIS_REPO = "public-transport/transport-apis";
const TRANSPORT_APIS_API = `https://api.github.com/repos/${TRANSPORT_APIS_REPO}`;
const TRANSPORT_APIS_USER_AGENT = "openmapx-transit-registry-bump";
const DATA_PATH_PREFIX = "data/";

export interface TransportApisLock {
  schemaVersion: 1;
  source: "public-transport-transport-apis";
  ref: string;
  commit: string;
  entryCount: number;
  lockedAt: string;
  lockedBy: string;
  comment?: string;
}

export interface TransportApisCandidate {
  lock: TransportApisLock;
  protocolCounts: Map<string, number>;
  rejectedIds: string[];
  listingSource: "jsdelivr" | "github";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`transport-apis lock: ${field} must be a non-empty string`);
  }
  return value;
}

export function decodeTransportApisLock(value: unknown): TransportApisLock {
  if (!isRecord(value)) throw new Error("transport-apis lock must be a JSON object");
  if (value.schemaVersion !== 1) {
    throw new Error(
      `transport-apis lock: unsupported schemaVersion ${String(value.schemaVersion)}`,
    );
  }
  if (value.source !== "public-transport-transport-apis") {
    throw new Error(`transport-apis lock: unexpected source ${String(value.source)}`);
  }
  const ref = assertString(value.ref, "ref");
  const commit = assertString(value.commit, "commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("transport-apis lock: commit must be a 40-hex SHA");
  }
  if (
    typeof value.entryCount !== "number" ||
    !Number.isInteger(value.entryCount) ||
    value.entryCount < 1
  ) {
    throw new Error("transport-apis lock: entryCount must be a positive integer");
  }
  const lockedAt = assertString(value.lockedAt, "lockedAt");
  if (Number.isNaN(Date.parse(lockedAt))) {
    throw new Error("transport-apis lock: lockedAt must be an ISO date-time");
  }
  const lockedBy = assertString(value.lockedBy, "lockedBy");
  if (value.comment !== undefined && typeof value.comment !== "string") {
    throw new Error("transport-apis lock: comment must be a string");
  }
  return {
    schemaVersion: 1,
    source: "public-transport-transport-apis",
    ref,
    commit,
    entryCount: value.entryCount,
    lockedAt,
    lockedBy,
    ...(value.comment !== undefined ? { comment: value.comment } : {}),
  };
}

export function transportApisLockJson(lock: TransportApisLock): string {
  const decoded = decodeTransportApisLock(lock);
  return `${JSON.stringify(
    {
      $schema: "./transport-apis.lock.schema.json",
      ...decoded,
    },
    null,
    2,
  )}\n`;
}

export function writeTransportApisLock(repoRoot: string, lock: TransportApisLock): void {
  const lockPath = join(repoRoot, "infra", "docker", "transport-apis.lock.json");
  const stagedPath = `${lockPath}.tmp-${process.pid}`;
  try {
    writeFileSync(stagedPath, transportApisLockJson(lock), "utf-8");
    renameSync(stagedPath, lockPath);
  } catch (error) {
    if (existsSync(stagedPath)) unlinkSync(stagedPath);
    throw error;
  }
}

function applyPinLiteral(source: string, name: string, value: string): string {
  const pattern = new RegExp(`(${name}\\s*=\\s*")[^"]*(")`);
  const updated = source.replace(pattern, (_match, prefix: string, suffix: string) => {
    return `${prefix}${value}${suffix}`;
  });
  if (updated === source) throw new Error(`Could not update ${name} in pin.ts`);
  return updated;
}

export function applyPinToSource(source: string, lock: TransportApisLock): string {
  const decoded = decodeTransportApisLock(lock);
  let updated = applyPinLiteral(source, "TRANSPORT_APIS_REF", decoded.ref);
  updated = applyPinLiteral(updated, "TRANSPORT_APIS_COMMIT", decoded.commit);
  updated = applyPinLiteral(updated, "TRANSPORT_APIS_LOCKED_AT", decoded.lockedAt);
  return updated;
}

interface JsDelivrFile {
  name?: unknown;
  type?: unknown;
  files?: unknown;
}

function collectDataPaths(node: unknown, prefix = ""): string[] {
  if (!isRecord(node) || !Array.isArray(node.files)) return [];
  const paths: string[] = [];
  for (const rawFile of node.files) {
    if (!isRecord(rawFile)) continue;
    const file = rawFile as JsDelivrFile;
    if (typeof file.name !== "string") continue;
    const name = file.name.replace(/^\/+/, "");
    const path = `${prefix}${name}`;
    if (file.type === "directory") {
      paths.push(...collectDataPaths(file, `${path}/`));
    } else if (path.startsWith(DATA_PATH_PREFIX) && path.endsWith(".json")) {
      paths.push(path);
    }
  }
  return [...new Set(paths)].sort();
}

function collectGithubDataPaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.tree)) return [];
  return value.tree
    .filter(
      (entry): entry is { path: string; type: string } =>
        isRecord(entry) &&
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        entry.path.startsWith(DATA_PATH_PREFIX) &&
        entry.path.endsWith(".json"),
    )
    .map((entry) => entry.path)
    .sort();
}

async function fetchJsonValue(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": TRANSPORT_APIS_USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  return response.json();
}

function dataUrl(base: string, path: string): string {
  return `${base}/${path}`;
}

function optionsFromPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const rawOptions = value.options;
  if (rawOptions === undefined || rawOptions === null) return {};
  return isRecord(rawOptions) ? rawOptions : null;
}

function entryIdFromPath(path: string): string {
  return path.replace(/^data\//, "").replace(/\.json$/, "");
}

async function resolveBranch(
  requestedBranch: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (requestedBranch?.trim()) return requestedBranch.trim();
  const repository = await fetchJsonValue(
    fetchImpl,
    TRANSPORT_APIS_API,
    "transport-apis repository lookup",
  );
  if (!isRecord(repository) || typeof repository.default_branch !== "string") {
    throw new Error("transport-apis repository lookup returned no default branch");
  }
  return repository.default_branch;
}

async function resolveCommit(branch: string, fetchImpl: typeof fetch): Promise<string> {
  const commit = await fetchJsonValue(
    fetchImpl,
    `${TRANSPORT_APIS_API}/commits/${encodeURIComponent(branch)}`,
    `transport-apis commit lookup for ${branch}`,
  );
  if (!isRecord(commit) || typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new Error("transport-apis commit lookup returned an invalid SHA");
  }
  return commit.sha;
}

async function resolveDataListing(
  commit: string,
  fetchImpl: typeof fetch,
): Promise<{ paths: string[]; source: "jsdelivr" | "github" }> {
  const jsdelivrUrl = `https://data.jsdelivr.com/v1/packages/gh/${TRANSPORT_APIS_REPO}@${commit}`;
  try {
    const listing = await fetchJsonValue(fetchImpl, jsdelivrUrl, "transport-apis jsDelivr listing");
    const paths = collectDataPaths(listing);
    if (paths.length === 0) throw new Error("listing contains no data/**/*.json files");
    return { paths, source: "jsdelivr" };
  } catch (jsdelivrError) {
    const treeUrl = `${TRANSPORT_APIS_API}/git/trees/${commit}?recursive=1`;
    try {
      const tree = await fetchJsonValue(fetchImpl, treeUrl, "transport-apis GitHub tree listing");
      const paths = collectGithubDataPaths(tree);
      if (paths.length === 0) throw new Error("tree contains no data/**/*.json files");
      log.warn(`jsDelivr cannot resolve ${commit.slice(0, 12)}; using GitHub tree fallback.`);
      return { paths, source: "github" };
    } catch (githubError) {
      throw new Error(
        `transport-apis listing failed via jsDelivr (${(jsdelivrError as Error).message}) and GitHub (${(githubError as Error).message})`,
      );
    }
  }
}

async function fetchCatalogFiles(
  paths: string[],
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<Array<{ path: string; value: unknown }>> {
  const files: Array<{ path: string; value: unknown }> = [];
  const maxConcurrent = 10;
  for (let i = 0; i < paths.length; i += maxConcurrent) {
    const batch = paths.slice(i, i + maxConcurrent);
    const values = await Promise.all(
      batch.map(async (path) => ({
        path,
        value: await fetchJsonValue(
          fetchImpl,
          dataUrl(baseUrl, path),
          `transport-apis file ${path}`,
        ),
      })),
    );
    files.push(...values);
  }
  return files;
}

function summarizeCatalog(files: Array<{ path: string; value: unknown }>): {
  entryCount: number;
  protocolCounts: Map<string, number>;
  rejectedIds: string[];
} {
  let entryCount = 0;
  const protocolCounts = new Map<string, number>();
  const rejectedIds: string[] = [];
  for (const { path, value } of files) {
    const options = optionsFromPayload(value);
    if (!options) continue;
    const rejection = registryEndpointRejection(options);
    if (rejection) {
      rejectedIds.push(entryIdFromPath(path));
      continue;
    }
    const entry = parseEntry(path, value);
    if (!entry) continue;
    entryCount++;
    protocolCounts.set(entry.protocol, (protocolCounts.get(entry.protocol) ?? 0) + 1);
  }
  return { entryCount, protocolCounts, rejectedIds: rejectedIds.sort() };
}

export async function resolveTransportApisCandidate(
  lockedBy: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  requestedBranch?: string,
): Promise<TransportApisCandidate> {
  const ref = await resolveBranch(requestedBranch, fetchImpl);
  const commit = await resolveCommit(ref, fetchImpl);
  const listing = await resolveDataListing(commit, fetchImpl);
  const fileBase =
    listing.source === "jsdelivr"
      ? `https://cdn.jsdelivr.net/gh/${TRANSPORT_APIS_REPO}@${commit}`
      : `https://raw.githubusercontent.com/${TRANSPORT_APIS_REPO}/${commit}`;
  const files = await fetchCatalogFiles(listing.paths, fileBase, fetchImpl);
  const summary = summarizeCatalog(files);
  if (summary.entryCount < 1)
    throw new Error("transport-apis candidate contains no parsed entries");
  return {
    lock: {
      schemaVersion: 1,
      source: "public-transport-transport-apis",
      ref,
      commit,
      entryCount: summary.entryCount,
      lockedAt: now().toISOString(),
      lockedBy,
      comment:
        "Pinned commit of public-transport/transport-apis consumed by integrations/transit-dynamic-registry. Bump via `pnpm openmapx transit-registry bump`.",
    },
    protocolCounts: summary.protocolCounts,
    rejectedIds: summary.rejectedIds,
    listingSource: listing.source,
  };
}

async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    log.err("Refusing to bump non-interactively. Re-run with --yes to skip confirmation.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function resolveLockedBy(): Promise<string> {
  try {
    const result = await execa("git", ["config", "user.email"], { stdio: "pipe" });
    const email = result.stdout.trim();
    if (email) return email;
  } catch {
    // Fall through to the environment fallback.
  }
  return process.env.USER ?? "unknown";
}

function readExistingLock(repoRoot: string): TransportApisLock | null {
  const lockPath = join(repoRoot, "infra", "docker", "transport-apis.lock.json");
  if (!existsSync(lockPath)) return null;
  try {
    return decodeTransportApisLock(JSON.parse(readFileSync(lockPath, "utf-8")));
  } catch {
    return null;
  }
}

function writePinAndLock(repoRoot: string, lock: TransportApisLock): void {
  const lockPath = join(repoRoot, "infra", "docker", "transport-apis.lock.json");
  const pinPath = join(repoRoot, "integrations", "transit-dynamic-registry", "pin.ts");
  const stagedLock = `${lockPath}.tmp-${process.pid}`;
  const stagedPin = `${pinPath}.tmp-${process.pid}`;
  const previousLock = existsSync(lockPath) ? readFileSync(lockPath) : null;
  const previousPin = readFileSync(pinPath);
  let pinReplaced = false;
  let lockReplaced = false;
  try {
    writeFileSync(stagedLock, transportApisLockJson(lock), "utf-8");
    writeFileSync(stagedPin, applyPinToSource(previousPin.toString("utf-8"), lock), "utf-8");
    renameSync(stagedPin, pinPath);
    pinReplaced = true;
    renameSync(stagedLock, lockPath);
    lockReplaced = true;
  } catch (error) {
    if (pinReplaced) writeFileSync(pinPath, previousPin);
    if (lockReplaced) {
      if (previousLock) writeFileSync(lockPath, previousLock);
      else if (existsSync(lockPath)) unlinkSync(lockPath);
    }
    for (const path of [stagedPin, stagedLock]) {
      if (existsSync(path)) unlinkSync(path);
    }
    throw new Error(
      `transport-apis pin update failed; previous files restored: ${(error as Error).message}`,
    );
  }
}

function printCandidateSummary(
  candidate: TransportApisCandidate,
  existing: TransportApisLock | null,
): void {
  log.info(`New transport-apis pin: ${candidate.lock.ref}@${candidate.lock.commit}`);
  log.info(`Listing source: ${candidate.listingSource}`);
  log.info(`Entries: ${existing?.entryCount ?? "none"} → ${candidate.lock.entryCount}`);
  log.info(
    `Protocols: ${[...candidate.protocolCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([protocol, count]) => `${protocol}=${count}`)
      .join(", ")}`,
  );
  log.info(`Endpoint rejections: ${candidate.rejectedIds.length}`);
  if (candidate.rejectedIds.length > 0) log.info(`  ${candidate.rejectedIds.join(", ")}`);
}

export function registerTransportApisPinCommands(program: Command): void {
  const registry = program
    .command("transit-registry")
    .description("Manage the transport-apis transit registry pin");

  registry
    .command("bump")
    .description("Resolve, review, and write an immutable transport-apis registry pin")
    .option("--yes", "Skip the interactive confirmation prompt", false)
    .option("--branch <name>", "Branch to track; defaults to the upstream default branch")
    .action(async (options: { yes: boolean; branch?: string }) => {
      const paths = repoPaths();
      const existing = readExistingLock(paths.root);
      const lockedBy = await resolveLockedBy();
      let candidate: TransportApisCandidate;
      try {
        candidate = await resolveTransportApisCandidate(
          lockedBy,
          fetch,
          () => new Date(),
          options.branch,
        );
      } catch (error) {
        log.err(
          `transport-apis candidate failed validation; no files changed: ${(error as Error).message}`,
        );
        process.exitCode = 1;
        return;
      }

      printCandidateSummary(candidate, existing);
      if (!options.yes) {
        const ok = await promptConfirm("Write this transport-apis pin? [y/N]");
        if (!ok) {
          log.info("Aborted — no pin files changed.");
          return;
        }
      }

      try {
        writePinAndLock(paths.root, candidate.lock);
      } catch (error) {
        log.err((error as Error).message);
        process.exitCode = 1;
        return;
      }
      log.ok(`Pinned transport-apis to ${candidate.lock.commit}`);
      log.dim("Run `pnpm check-toolchain-pins` to verify all consumers use this revision.");
    });

  registry
    .command("show")
    .description("Print the current transport-apis lockfile contents")
    .action(() => {
      const lockPath = join(repoPaths().root, "infra", "docker", "transport-apis.lock.json");
      if (!existsSync(lockPath)) {
        log.warn(
          "No infra/docker/transport-apis.lock.json found. Run `pnpm openmapx transit-registry bump` to create one.",
        );
        return;
      }
      console.log(readFileSync(lockPath, "utf-8"));
    });
}
