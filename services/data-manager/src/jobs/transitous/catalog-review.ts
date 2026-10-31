/** Paired proposal resolution. Validation and activation consume the same retained intent. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type ControlInstallation,
  controlDigest,
  signControl,
  verifyControl,
  verifyDataControlTerminalWitness,
} from "@openmapx/core/build-artifacts";
import {
  type CatalogProposal,
  catalogProposalInputSchema,
  catalogProposalSchema,
  createCatalogPinSet,
  parseCatalogPinSet,
  readCatalogValidation,
  readCurrentCatalogValidation,
  sameCatalogRuntimeInputs,
  scopeCatalogRuntimeInputs,
} from "@openmapx/core/catalog-pins";
import { canonicalJson } from "@openmapx/core/ops";
import { safeFetchTextResponse } from "@openmapx/core/utils/safe-download";
import {
  type CatalogFeedDiff,
  catalogCompilerSettings,
  catalogDiffPage,
  catalogReviewInputDigests,
  fetchPinnedGbfsCatalog,
  parseCatalogGbfsRows,
  readAtlasFeedSnapshot,
  readCatalogFeedSnapshot,
  resolveGbfsCatalogCandidate,
  reviewCatalogPair,
} from "@openmapx/transitous-core";
import { execa } from "execa";
import z from "zod/v4";
import { installationState } from "../../../../../packages/core/src/build-artifacts/control-authority";
import {
  AnchoredDirectory,
  identity,
  sameInode,
} from "../../../../../packages/core/src/build-artifacts/filesystem";
import { runOpsOperation } from "../../ops-client.js";
import { withLegacyDataMutation } from "../execution/legacy-mutation.js";
import { readFeedOverlay } from "../transitous-feeds-overlay.js";
import { CANDIDATE_MANIFEST_FILENAME } from "./candidate.js";
import {
  CatalogBumpError,
  lockFromCandidate,
  resolveCatalogBumpCandidate,
} from "./catalog-bump.js";
import { resolveTransitOverlayPath } from "./internal.js";
import { type MotisOperationsPolicy, transitAllowedCountries } from "./operations-profile.js";
import { readMotisSlotState } from "./slot-state.js";

const DOMAIN = "openmapx-catalog-resolution-v1";
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const resolutionSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  branch: z
    .string()
    .max(215)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  proposal: catalogProposalInputSchema,
  overlayDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
});
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const safeUpstreamFetch: typeof fetch = async (input, init) => {
  const response = await safeFetchTextResponse(String(input), {
    maxBytes: String(input).includes("api.github.com") ? 65536 : 32 * 1024 * 1024,
    timeoutMs: 30000,
    signal: init?.signal ?? undefined,
    maxRedirects: 0,
    allowPrivateHosts: [],
    headers: Object.fromEntries(new Headers(init?.headers)),
  });
  if (response.finalUrl !== String(input)) throw Error("Catalog upstream changed its fixed URL");
  return new Response(response.text, { status: response.status, headers: response.headers });
};

/** Dependencies are the literal installed service, not values or callbacks from a request. */
export function createCatalogReviewService(options: {
  dataDir: string;
  installation: ControlInstallation;
  operationsPolicy: MotisOperationsPolicy;
}) {
  const state = installationState(options.installation);
  if (options.installation.role !== "data-manager" || state.fixedChildId)
    throw Error("Original Data Manager installation required");
  const expected = new AnchoredDirectory(state.dataRoot),
    actual = new AnchoredDirectory(options.dataDir);
  try {
    if (!sameInode(identity(expected.stat), identity(actual.stat)))
      throw Error("Foreign catalog review data root");
  } finally {
    expected.close();
    actual.close();
  }
  function directory<T>(
    proposalId: string,
    create: boolean,
    run: (directory: AnchoredDirectory) => T,
  ): T {
    const id = catalogProposalInputSchema.shape.proposalId.parse(proposalId),
      opened: AnchoredDirectory[] = [];
    try {
      let root = new AnchoredDirectory(options.dataDir);
      opened.push(root);
      for (const name of ["motis", "proposals", id]) {
        root = root.directory(name, create, name !== "motis");
        opened.push(root);
      }
      return run(root);
    } finally {
      for (const root of opened.reverse()) root.close();
    }
  }
  function sourceSnapshot() {
    const overlay = readFeedOverlay(resolveTransitOverlayPath(options.dataDir));
    return {
      overlay,
      ...catalogReviewInputDigests(
        options.operationsPolicy,
        overlay,
        catalogCompilerSettings(process.env),
      ),
    };
  }
  function retainedResolution(proposalId: string) {
    try {
      return directory(proposalId, false, (dir) => {
        const value = verifyControl(
          state.installation.publicKey,
          DOMAIN,
          JSON.parse(dir.read("resolution.json", 768 * 1024).toString("utf8")),
          resolutionSchema,
        );
        if (
          value.installationId !== options.installation.installationId ||
          value.proposal.proposalId !== proposalId
        )
          throw Error("Foreign catalog resolution");
        parseCatalogPinSet(value.proposal.pins);
        const bytes = dir.read("diff.json", MAX_DIFF_BYTES);
        if (createHash("sha256").update(bytes).digest("hex") !== value.proposal.diffDigest)
          throw Error("Retained catalog diff changed");
        return value;
      });
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async function readProposal(proposalId: string): Promise<CatalogProposal> {
    const result = await runOpsOperation({ kind: "transitousLock.inspect", proposalId, offset: 0 });
    const proposal = catalogProposalSchema.parse(result.proposal);
    if (proposal.proposalId !== proposalId) throw Error("Catalog proposal identity changed");
    parseCatalogPinSet(proposal.pins);
    return proposal;
  }
  async function resolveCatalogProposal(input: {
    branch: string;
    signal?: AbortSignal;
    proposalId?: string;
  }): Promise<CatalogProposal> {
    const branch = resolutionSchema.shape.branch.parse(input.branch),
      proposalId = input.proposalId ?? randomUUID();
    return withLegacyDataMutation("transit-proposal", async () => {
      input.signal?.throwIfAborted();
      let resolution = retainedResolution(proposalId);
      if (resolution && resolution.branch !== branch)
        throw Error("Original catalog branch changed");
      if (!resolution) {
        const active = await runOpsOperation(
            { kind: "catalogPins.inspect" },
            { signal: input.signal },
          ),
          snapshot = sourceSnapshot();
        const catalogDir = join(options.dataDir, ".transitous-catalog");
        const candidate = await resolveCatalogBumpCandidate({ catalogDir, branch });
        const gbfs = await resolveGbfsCatalogCandidate(
          "catalog-review",
          safeUpstreamFetch,
          () => new Date(),
          input.signal,
        );
        const pins = createCatalogPinSet(
          lockFromCandidate(
            candidate,
            "catalog-review",
            "Proposed for explicit source/license review",
          ),
          gbfs.lock,
        );
        const gitAt = async (directory: string, args: string[]) =>
          (
            await execa("git", ["-c", `safe.directory=${directory}`, "-C", directory, ...args], {
              cancelSignal: input.signal,
              timeout: 30000,
              maxBuffer: 16 * 1024 * 1024,
            })
          ).stdout;
        const git = (args: string[]) => gitAt(catalogDir, args),
          atlasDir = join(catalogDir, "transitland-atlas");
        const atlasCommits = [
          ...new Set([
            candidate.transitlandAtlasSha,
            ...(active.active ? [active.active.transitous.submodules["transitland-atlas"]!] : []),
          ]),
        ];
        if (!existsSync(join(atlasDir, ".git")))
          throw new CatalogBumpError(
            "submodule-cache-unavailable",
            "Initialize the pinned catalog and Atlas cache before proposing updates",
          );
        for (const commit of atlasCommits) {
          try {
            await gitAt(atlasDir, ["cat-file", "-e", `${commit}^{commit}`]);
          } catch (error) {
            if (![1, 128].includes((error as { exitCode?: number }).exitCode ?? -1)) throw error;
            await gitAt(atlasDir, ["fetch", "--no-tags", "--depth=1", "origin", commit]);
            await gitAt(atlasDir, ["cat-file", "-e", `${commit}^{commit}`]);
          }
        }
        const [previousFeeds, nextFeeds, previousGbfs] = await Promise.all([
          active.active
            ? readCatalogFeedSnapshot(active.active.transitous.ref.split("@").at(-1)!, git)
            : Promise.resolve(new Map()),
          readCatalogFeedSnapshot(candidate.transitousSha, git),
          active.active
            ? fetchPinnedGbfsCatalog(active.active.gbfs, safeUpstreamFetch, input.signal)
            : Promise.resolve(null),
        ]);
        const [previousAtlas, nextAtlas] = await Promise.all([
          active.active
            ? readAtlasFeedSnapshot(
                active.active.transitous.submodules["transitland-atlas"]!,
                (args) => gitAt(atlasDir, args),
              )
            : Promise.resolve(new Map()),
          readAtlasFeedSnapshot(candidate.transitlandAtlasSha, (args) => gitAt(atlasDir, args)),
        ]);
        const diff = reviewCatalogPair({
          previousAtlas,
          nextAtlas,
          previousFeeds,
          nextFeeds,
          previousGbfsRows: previousGbfs ? parseCatalogGbfsRows(previousGbfs) : [],
          nextGbfsRows: gbfs.rows,
          countries: transitAllowedCountries(options.operationsPolicy),
          quarantine: snapshot.overlay?.quarantine ?? [],
          maxAdditions: Number.parseInt(
            catalogCompilerSettings(process.env).MOTIS_GBFS_CATALOG_MAX_ADDITIONS!,
            10,
          ),
        });
        // Preflight every complete row before retaining a proposal that the
        // bounded review endpoint could not actually display.
        for (let offset = 0; offset < diff.total; ) {
          const page = catalogDiffPage(diff, offset);
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        const bytes = canonicalJson(diff);
        if (Buffer.byteLength(bytes, "utf8") > MAX_DIFF_BYTES)
          throw Error("Catalog review exceeds its byte limit");
        if (canonicalJson(snapshot) !== canonicalJson(sourceSnapshot()))
          throw Error("Catalog source policy changed during resolution");
        resolution = resolutionSchema.parse({
          version: 1,
          installationId: options.installation.installationId,
          branch,
          proposal: {
            proposalId,
            baseGenerationId: active.catalogRevisionId,
            pins,
            diffDigest: createHash("sha256").update(bytes).digest("hex"),
            sourcePolicyRevision: snapshot.sourcePolicyRevision,
          },
          overlayDigest: snapshot.overlayDigest,
          createdAt: new Date().toISOString(),
        });
        directory(proposalId, true, (dir) => {
          dir.write("diff.json", bytes, true);
          const envelope = canonicalJson(signControl(state.privateKey, DOMAIN, resolution));
          if (Buffer.byteLength(envelope, "utf8") > 768 * 1024)
            throw Error("Catalog resolution exceeds its byte limit");
          dir.write("resolution.json", envelope, true);
        });
      }
      await runOpsOperation(
        { kind: "transitousLock.propose", ...resolution.proposal },
        { signal: input.signal },
      );
      return readProposal(proposalId);
    });
  }
  function reviewPage(proposalId: string, offset = 0) {
    const resolution = retainedResolution(proposalId);
    if (!resolution) throw Error("Catalog proposal resolution is unavailable");
    return directory(proposalId, false, (dir) => ({
      ...catalogDiffPage(
        JSON.parse(dir.read("diff.json", MAX_DIFF_BYTES).toString("utf8")) as CatalogFeedDiff,
        offset,
      ),
      digest: resolution.proposal.diffDigest,
    }));
  }
  async function reviewState(query: {
    proposalId?: string;
    offset?: number;
    diffOffset?: number;
    validationId?: string;
  }) {
    const [host, active] = await Promise.all([
      runOpsOperation({
        kind: "transitousLock.inspect",
        ...(query.proposalId ? { proposalId: query.proposalId } : {}),
        offset: query.offset ?? 0,
      }),
      runOpsOperation({ kind: "catalogPins.inspect" }),
    ]);
    const proposal = host.proposal ?? null,
      diff = proposal ? reviewPage(proposal.proposalId, query.diffOffset ?? 0) : null;
    let validation: import("@openmapx/core/catalog-pins").CatalogValidation | null = null,
      validationEligible = false,
      blocker = host.validationBlocker ?? null;
    if (proposal && query.validationId) {
      try {
        const retained = readCatalogValidation(
          options.installation,
          proposal.proposalId,
          query.validationId,
        );
        validation = retained.validation;
        if (validation.status === "passed") {
          const completed = verifyDataControlTerminalWitness(
              options.installation,
              retained.sourceExecution,
            ),
            pointer = readCurrentCatalogValidation(options.installation),
            slots = readMotisSlotState(options.dataDir);
          if (
            completed.status.status !== "ok" ||
            completed.status.result?.kind !== "catalog.validate" ||
            completed.status.result.status !== "passed" ||
            pointer?.selected?.validationId !== validation.validationId ||
            pointer.selected.validationDigest !== controlDigest(retained) ||
            Date.now() >= Date.parse(validation.expiresAt) ||
            controlDigest(proposal) !== retained.proposalDigest ||
            proposal.baseGenerationId !== active.catalogRevisionId ||
            !host.validationInputs ||
            !sameCatalogRuntimeInputs(
              retained.runtimeInputs,
              scopeCatalogRuntimeInputs(host.validationInputs, validation.countries),
            ) ||
            !slots ||
            slots.activeSlot === validation.slot
          )
            throw Error("Catalog validation is stale, incomplete or already activated");
          const candidate = new AnchoredDirectory(
            realpathSync(join(options.dataDir, "motis", "slots", validation.slot)),
          );
          try {
            if (
              createHash("sha256")
                .update(candidate.read(CANDIDATE_MANIFEST_FILENAME, 32 * 1024 * 1024, false))
                .digest("hex") !== validation.manifestHash
            )
              throw Error("Validated slot changed");
          } finally {
            candidate.close();
          }
          validationEligible = true;
        } else blocker = validation.reason;
      } catch {
        blocker ??=
          "Validation is incomplete, stale or its slot was reused. Run a fresh validation before activation.";
      }
    }
    return {
      ...active,
      allowedCountries: transitAllowedCountries(options.operationsPolicy),
      page: host.page ?? { proposals: [], total: 0, offset: query.offset ?? 0, nextOffset: null },
      proposal,
      diff,
      validation,
      execution: null,
      validationInputs: host.validationInputs ?? null,
      validationEligible,
      blocker,
    };
  }
  return { resolveCatalogProposal, readProposal, reviewPage, sourceSnapshot, reviewState };
}
