/** Destination-only offline MOTIS reconstruction; no Docker, HTTP or lifecycle calls. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { TRANSITOUS_CATALOG_DIR } from "@openmapx/transitous-core";
import { parseFeedCredentialMapJson } from "@openmapx/transitous-core/feed-credentials";
import { readCatalogPinSet } from "../catalog-pins";
import { GENERATED_SECRETS_DIRNAME } from "../services/compose-renderer";
import { currentConfigurationGeneration } from "../services/configuration-generation";
import { CONFIGURATION_GENERATIONS } from "../services/deployment";
import { AnchoredDirectory } from "./filesystem";
import { portableMotisSourcesSchema } from "./manifest";
import {
  createMotisPinnedBlobReader,
  inspectPortableMotisRecipe,
  MAX_MOTIS_MATERIALIZATION_BYTES,
  materializePortableMotisCandidate,
  PORTABLE_MOTIS_FILENAME,
} from "./motis-portable";
export interface MotisPortableDestinationInput {
  /** Host-selected checkout and infra roots, never operation/body fields. */
  rootDir: string;
  infraDir: string;
  /** Store-selected extracted motis/live directory, never a caller path. */
  stagingDir: string;
  configurationRevisionId: string;
  /** The agent's current fixed Compose config output for data-manager. */
  dataManagerEnvironment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}
const digest = (raw: unknown) => createHash("sha256").update(JSON.stringify(raw)).digest("hex");
async function destination(input: MotisPortableDestinationInput) {
  input.signal?.throwIfAborted();
  if (currentConfigurationGeneration(input.infraDir) !== input.configurationRevisionId)
    throw Error("MOTIS destination configuration changed; preview again");
  const pair = readCatalogPinSet(input.rootDir);
  if (!pair) throw Error("MOTIS destination requires an approved retained catalog pin set");
  const pins = {
    transitousCommit: pair.transitous.ref.split("@").at(-1) ?? "",
    atlasCommit: pair.transitous.submodules["transitland-atlas"] ?? "",
  };
  const stage = new AnchoredDirectory(realpathSync(input.stagingDir));
  let metadata: ReturnType<typeof portableMotisSourcesSchema.parse>;
  try {
    metadata = portableMotisSourcesSchema.parse(
      JSON.parse(stage.read(PORTABLE_MOTIS_FILENAME, 1024 * 1024, false).toString("utf8")),
    );
  } finally {
    stage.close();
  }
  if (!metadata.recipe)
    throw Error("MOTIS bundle has no offline recipe; rebuild the source candidate");
  const readBlob = createMotisPinnedBlobReader(
    join(input.infraDir, "data", TRANSITOUS_CATALOG_DIR),
    pins,
    input.signal,
  );
  const inspected = await inspectPortableMotisRecipe({ recipe: metadata.recipe, pins, readBlob });
  if (
    JSON.stringify(inspected.credentialRequirements) !==
      JSON.stringify([...metadata.credentialRequirements].sort()) ||
    JSON.stringify(metadata.sourceFingerprints) !==
      JSON.stringify(
        inspected.recipe.candidate.artifacts.datasets.map((f) => ({
          id: f.path,
          sha256: f.sha256,
          sizeBytes: f.sizeBytes,
        })),
      )
  )
    throw Error("MOTIS portable source or credential inventory does not match its candidate");
  let credentials: Readonly<Record<string, string>> = {},
    credentialIdentity: unknown = null;
  const env = input.dataManagerEnvironment;
  if (inspected.credentialRequirements.length) {
    if (
      env.TRANSITOUS_API_KEYS_PATH ||
      (env.TRANSITOUS_API_KEYS_FILE &&
        env.TRANSITOUS_API_KEYS_FILE !== "/run/secrets/TRANSITOUS_API_KEYS")
    )
      throw Error(
        "MOTIS credentials are host-owned; prepare a supported managed credential generation before importing",
      );
    if (env.TRANSITOUS_API_KEYS_FILE !== "/run/secrets/TRANSITOUS_API_KEYS")
      throw Error("MOTIS destination requires the selected managed feed credentials");
    const opened: AnchoredDirectory[] = [];
    try {
      let directory = new AnchoredDirectory(realpathSync(input.infraDir));
      opened.push(directory);
      for (const part of [
        CONFIGURATION_GENERATIONS,
        input.configurationRevisionId,
        GENERATED_SECRETS_DIRNAME,
        "data-manager",
      ]) {
        directory = directory.directory(part);
        opened.push(directory);
      }
      const path = directory.name("TRANSITOUS_API_KEYS"),
        before = lstatSync(path, { bigint: true }),
        bytes = directory.read("TRANSITOUS_API_KEYS", 65536, false),
        after = lstatSync(path, { bigint: true });
      const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
      if (fields.some((key) => before[key] !== after[key]))
        throw Error("MOTIS destination credentials changed; preview again");
      credentials = parseFeedCredentialMapJson(
        new TextDecoder("utf8", { fatal: true }).decode(bytes),
      );
      if (inspected.credentialRequirements.some((key) => !credentials[key]))
        throw Error("MOTIS destination has missing feed credentials");
      credentialIdentity = fields.map((key) => String(after[key]));
    } finally {
      for (const directory of opened.reverse()) directory.close();
    }
  }
  if (
    currentConfigurationGeneration(input.infraDir) !== input.configurationRevisionId ||
    readCatalogPinSet(input.rootDir)?.generationId !== pair.generationId
  )
    throw Error("MOTIS destination catalog or configuration changed; preview again");
  const fingerprint = digest({
    recipe: metadata.recipe,
    pins: pair.generationId,
    configuration: input.configurationRevisionId,
    credentialIdentity,
  });
  return {
    recipe: inspected.recipe,
    pins,
    readBlob,
    credentials,
    fingerprint,
    requiredCredentials: inspected.credentialRequirements,
  };
}
/** A masked prerequisite snapshot; no raw credential values leave this function. */
export async function inspectMotisPortableDestination(input: MotisPortableDestinationInput) {
  const value = await destination(input);
  return {
    fingerprint: value.fingerprint,
    requiredCredentials: value.requiredCredentials,
    materializationMaxBytes: MAX_MOTIS_MATERIALIZATION_BYTES,
  };
}
/** Caller holds the original target/configuration writer leases and stopped-consumer fence. */
export async function materializeMotisPortableDestination(
  input: MotisPortableDestinationInput & {
    expectedFingerprint: string;
    archiveFingerprint: string;
  },
) {
  const value = await destination(input);
  if (value.fingerprint !== input.expectedFingerprint)
    throw Error("MOTIS destination prerequisites changed; preview again");
  const manifest = await materializePortableMotisCandidate({
    archiveFingerprint: input.archiveFingerprint,
    stagingDir: input.stagingDir,
    recipe: value.recipe,
    pins: value.pins,
    readBlob: value.readBlob,
    credentials: value.credentials,
    signal: input.signal,
  });
  // Detect changed pins/generation/credential inode after the bounded write. The
  // private candidate remains unpublished if this fence fails.
  if ((await destination(input)).fingerprint !== input.expectedFingerprint)
    throw Error("MOTIS destination prerequisites changed during materialization");
  return manifest;
}
