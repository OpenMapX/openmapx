/** Immutable agent-retained proposals; retaining one never selects active pins. */
import { join } from "node:path";
import { type ControlInstallation, controlDigest } from "../build-artifacts/control-records";
import { AnchoredDirectory, identity, sameInode } from "../build-artifacts/filesystem";
import { installationState } from "../build-artifacts/private-records";
import { canonicalJson } from "../ops/canonical-json";
import { withConfigurationGenerationWriter } from "../services/configuration-generation";
import { parseCatalogPinSet } from "./generation";
import { pinnedAtlasCommit } from "./pinned-commits";
import {
  type CatalogProposal,
  type CatalogProposalInput,
  catalogProposalEnvelopePayloadSchema,
  catalogProposalInputSchema,
} from "./proposal-schemas";
import { readCatalogPinSet } from "./store";

export const MAX_CATALOG_PROPOSAL_BYTES = 768 * 1024;
function withProposalDirectory<T>(
  rootDir: string,
  installation: ControlInstallation,
  create: boolean,
  run: (directory: AnchoredDirectory) => T,
): T {
  const state = installationState(installation),
    opened: AnchoredDirectory[] = [];
  try {
    const expected = new AnchoredDirectory(state.dataRoot);
    opened.push(expected);
    const actual = new AnchoredDirectory(join(rootDir, "infra/docker/data"));
    opened.push(actual);
    if (!sameInode(identity(expected.stat), identity(actual.stat)))
      throw Error("Foreign catalog proposal root");
    // The trusted mount is infra/docker; Docker may own its unmounted ancestors.
    let directory = new AnchoredDirectory(join(rootDir, "infra/docker"));
    opened.push(directory);
    for (const name of ["catalog-pins", "proposals"]) {
      directory = directory.directory(name, create, true);
      opened.push(directory);
    }
    return run(directory);
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
function decode(installation: ControlInstallation, bytes: Buffer): CatalogProposal {
  installationState(installation);
  const value = catalogProposalEnvelopePayloadSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (value.proposal.state !== "proposed") throw Error("Foreign catalog proposal");
  parseCatalogPinSet(value.proposal.pins);
  return value.proposal;
}
export function readCatalogProposal(input: {
  rootDir: string;
  installation: ControlInstallation;
  proposalId: string;
}): CatalogProposal | null {
  const id = catalogProposalInputSchema.shape.proposalId.parse(input.proposalId);
  try {
    return withProposalDirectory(input.rootDir, input.installation, false, (directory) =>
      decode(input.installation, directory.read(`${id}.json`, MAX_CATALOG_PROPOSAL_BYTES)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function retainCatalogProposal(input: {
  rootDir: string;
  installation: ControlInstallation;
  proposal: CatalogProposalInput;
  now?: Date;
  signal?: AbortSignal;
}): Promise<CatalogProposal> {
  const state = installationState(input.installation);
  if (input.installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Catalog proposal requires the original operations agent");
  const proposal = catalogProposalInputSchema.parse(input.proposal);
  parseCatalogPinSet(proposal.pins);
  pinnedAtlasCommit(proposal.pins.transitous);
  return withConfigurationGenerationWriter(
    join(input.rootDir, "infra/docker"),
    async () =>
      withProposalDirectory(input.rootDir, input.installation, true, (directory) => {
        const name = `${proposal.proposalId}.json`;
        let existing: CatalogProposal | null = null;
        try {
          existing = decode(input.installation, directory.read(name, MAX_CATALOG_PROPOSAL_BYTES));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (existing) {
          const { state: _state, createdAt: _time, ...original } = existing;
          if (controlDigest(original) !== controlDigest(proposal))
            throw Error("Immutable catalog proposal changed");
          return existing;
        }
        if ((readCatalogPinSet(input.rootDir)?.generationId ?? null) !== proposal.baseGenerationId)
          throw Error("Catalog proposal base changed");
        if (directory.listBounded(4096).length >= 4096)
          throw Error("Catalog proposal capacity reached");
        const retained: CatalogProposal = {
          ...proposal,
          state: "proposed",
          createdAt: (input.now ?? new Date()).toISOString(),
        };
        const bytes = canonicalJson({
          version: 1,
          proposal: retained,
        });
        if (Buffer.byteLength(bytes, "utf8") > MAX_CATALOG_PROPOSAL_BYTES)
          throw Error("Catalog proposal exceeds its byte limit");
        directory.write(name, bytes);
        return retained;
      }),
    input.signal,
  );
}
/** Bounded metadata only; selecting a proposal separately re-reads and re-checks it. */
export function listCatalogProposals(input: {
  rootDir: string;
  installation: ControlInstallation;
  offset?: number;
}) {
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4096)
    throw Error("Invalid catalog proposal offset");
  try {
    return withProposalDirectory(input.rootDir, input.installation, false, (directory) => {
      const ids = directory.listBounded(4096).sort();
      const proposals = ids.slice(offset, offset + 100).map((name) => {
        const id = catalogProposalInputSchema.shape.proposalId.parse(name.replace(/\.json$/, ""));
        if (name !== `${id}.json`) throw Error("Unexpected catalog proposal record");
        const proposal = decode(
          input.installation,
          directory.read(name, MAX_CATALOG_PROPOSAL_BYTES),
        );
        if (proposal.proposalId !== id) throw Error("Catalog proposal filename mismatch");
        const { pins, ...metadata } = proposal;
        const atlasCommit = pinnedAtlasCommit(pins.transitous);
        return {
          ...metadata,
          catalogRevisionId: pins.generationId,
          transitousRef: pins.transitous.ref,
          atlasCommit,
          gbfsCommit: pins.gbfs.commit,
        };
      });
      return {
        proposals,
        total: ids.length,
        offset,
        nextOffset: offset + proposals.length < ids.length ? offset + proposals.length : null,
      };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { proposals: [], total: 0, offset, nextOffset: null };
    throw error;
  }
}
