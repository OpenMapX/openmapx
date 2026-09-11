import type { DataManagerCoverageEvidencePage } from "@openmapx/core/server";
import { services as coreServices } from "@openmapx/core/server";
import { serviceUrl } from "../service-registry.js";

const { DataManagerClient, DataManagerHttpError } = coreServices;

const DATA_MANAGER_TIMEOUT_MS = 3_000;
const DATA_MANAGER_MAX_PAGES = 100;
const DATA_MANAGER_PAGE_SIZE = 100;

export interface DataManagerEvidenceSnapshot {
  snapshotId: string;
  generatedAt: string;
  evaluatedAt: string;
  collectionStatus: DataManagerCoverageEvidencePage["collectionStatus"];
  authorities: DataManagerCoverageEvidencePage["authorities"];
  warnings: DataManagerCoverageEvidencePage["warnings"];
  regions: DataManagerCoverageEvidencePage["regions"];
  evidence: DataManagerCoverageEvidencePage["evidence"];
  rights: NonNullable<DataManagerCoverageEvidencePage["rights"]>;
  total: number;
  retainedTotal: number;
  truncated: boolean;
  unassignedSourceCount: number;
}

export interface DataManagerEvidenceReader {
  read(): Promise<DataManagerEvidenceSnapshot>;
}

type DataManagerCoverageClient = {
  coverageEvidence(query?: {
    snapshotId?: string;
    offset?: number;
    limit?: number;
  }): Promise<DataManagerCoverageEvidencePage>;
};

export class DataManagerEvidenceUnavailableError extends Error {
  readonly authority = "data-manager" as const;

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataManagerEvidenceUnavailableError";
  }
}

function baseUrl(): string {
  const configured = process.env.DATA_MANAGER_URL?.trim();
  if (configured) return configured;
  return serviceUrl("data-manager") ?? "http://data-manager:4000";
}

function combinePages(
  first: DataManagerCoverageEvidencePage,
  pages: DataManagerCoverageEvidencePage[],
): DataManagerEvidenceSnapshot {
  const evidence = pages
    .flatMap((page) => page.evidence)
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    snapshotId: first.snapshotId,
    generatedAt: first.generatedAt,
    evaluatedAt: pages.at(-1)?.evaluatedAt ?? first.evaluatedAt,
    collectionStatus: pages.some((page) => page.collectionStatus === "unavailable")
      ? "unavailable"
      : pages.some((page) => page.collectionStatus === "partial")
        ? "partial"
        : "complete",
    authorities: first.authorities,
    warnings: [...new Set(pages.flatMap((page) => page.warnings))],
    regions: first.regions,
    evidence,
    rights: first.rights ?? [],
    total: first.total,
    retainedTotal: first.retainedTotal,
    truncated: first.truncated,
    unassignedSourceCount: first.unassignedSourceCount,
  };
}

/** Read the single immutable data-manager revision, retrying one expired page chain. */
export async function readDataManagerEvidence(
  client: DataManagerCoverageClient,
): Promise<DataManagerEvidenceSnapshot> {
  const deadline = Date.now() + DATA_MANAGER_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const first = await client.coverageEvidence({ limit: DATA_MANAGER_PAGE_SIZE });
      const pages = [first];
      let offset = first.pagination.offset + first.evidence.length;
      for (let page = 1; page < DATA_MANAGER_MAX_PAGES && first.pagination.hasMore; page++) {
        if (Date.now() >= deadline)
          throw new DataManagerEvidenceUnavailableError("data-manager evidence read timed out");
        const next = await client.coverageEvidence({
          snapshotId: first.snapshotId,
          offset,
          limit: DATA_MANAGER_PAGE_SIZE,
        });
        if (next.snapshotId !== first.snapshotId) {
          throw new DataManagerEvidenceUnavailableError(
            "data-manager revision changed during read",
            409,
          );
        }
        if (next.pagination.offset !== offset || next.pagination.total !== first.pagination.total) {
          throw new DataManagerEvidenceUnavailableError(
            "data-manager evidence page sequence changed",
            409,
          );
        }
        if (next.evidence.length === 0 && next.pagination.hasMore)
          throw new DataManagerEvidenceUnavailableError("empty continuation page");
        pages.push(next);
        offset += next.evidence.length;
        if (!next.pagination.hasMore) break;
      }
      if (pages.at(-1)?.pagination.hasMore) {
        throw new DataManagerEvidenceUnavailableError("data-manager evidence page limit exceeded");
      }
      return combinePages(first, pages);
    } catch (error) {
      if (error instanceof DataManagerHttpError && error.status === 409 && attempt === 0) continue;
      if (
        error instanceof DataManagerEvidenceUnavailableError &&
        error.status === 409 &&
        attempt === 0
      )
        continue;
      if (error instanceof DataManagerEvidenceUnavailableError) throw error;
      throw new DataManagerEvidenceUnavailableError(
        error instanceof Error ? error.message.slice(0, 500) : "data-manager evidence unavailable",
        error instanceof DataManagerHttpError ? error.status : undefined,
      );
    }
  }
  throw new DataManagerEvidenceUnavailableError("data-manager evidence revision expired");
}

export function createDataManagerEvidenceReader(
  options: { client?: DataManagerCoverageClient; baseUrl?: string; authToken?: string } = {},
): DataManagerEvidenceReader {
  const client =
    options.client ??
    new DataManagerClient({
      baseUrl: options.baseUrl ?? baseUrl(),
      authToken: options.authToken,
      requestTimeoutMs: DATA_MANAGER_TIMEOUT_MS,
      maxJsonBytes: 4 * 1024 * 1024 + 128 * 1024,
    });
  return { read: () => readDataManagerEvidence(client) };
}
