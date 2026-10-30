import { z } from "zod";
import { ServiceRegistry } from "../services/registry";
import { serviceContainerImageReference } from "../services/types";
import { artifactFingerprint, safeArtifactPath } from "./artifact-path";
import { portableMotisRecipeSchema } from "./motis-portable";
export interface BuildArtifactSpec {
  dirs: string[];
  exclude: string[];
  consumers: string[];
}
export const BUILD_ARTIFACTS: Readonly<Record<string, BuildArtifactSpec>> = {
  tileserver: { dirs: ["tile-mbtiles"], exclude: [], consumers: ["tileserver"] },
  osrm: { dirs: ["osrm-graph"], exclude: ["osrm-graph/region.osm.pbf"], consumers: ["osrm"] },
  otp: { dirs: ["otp-graph"], exclude: ["*.pbf", "*.zip"], consumers: ["otp"] },
  pelias: {
    dirs: ["pelias"],
    exclude: ["pelias/openstreetmap/"],
    consumers: ["pelias", "pelias-pip", "pelias-placeholder", "elasticsearch"],
  },
  motis: {
    dirs: ["motis/live", "motis-feed-proxy"],
    exclude: [],
    consumers: ["motis", "motis-staging", "motis-feed-proxy"],
  },
};
export function buildArtifactSpec(serviceId: string): BuildArtifactSpec {
  const spec = Object.hasOwn(BUILD_ARTIFACTS, serviceId) ? BUILD_ARTIFACTS[serviceId] : undefined;
  if (!spec)
    throw Error(
      `Service "${serviceId}" has no exportable build artifact; database services require their supported backup workflow`,
    );
  return structuredClone(spec);
}
export const BUILD_RECORD_DIR = ".openmapx-builds";
export const BUNDLE_MANIFEST_PATH = ".openmapx-bundle/manifest.json";
export interface BuildRecord {
  schemaVersion: 1;
  service: string;
  builtAt: string;
  region?: string;
  revision?: string;
  sourcePbf?: { name: string; sizeBytes: number };
  runtimeImages: Record<string, string>;
  toolImages: Record<string, string>;
}
export interface BuildRecordV2 extends Omit<BuildRecord, "schemaVersion"> {
  schemaVersion: 2;
  sourceFingerprints: Array<{ id: string; sha256: string; sizeBytes: number }>;
  artifactFingerprint: string;
  credentialRequirements?: string[];
  runtimeMaterialization?: "motis-target-credentials";
}
export interface BundleFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}
export type BundleManifest = (BuildRecord | BuildRecordV2) & {
  dirs: string[];
  directories: string[];
  files: BundleFile[];
};
export type ImageMismatch = { service: string; bundle: string; local: string };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const string = z.string().min(1).max(4096);
const size = z.number().int().nonnegative().safe();
const images = z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), string);
const common = {
  service: z.string().max(64),
  builtAt: z.iso.datetime(),
  region: string.optional(),
  revision: string.optional(),
  sourcePbf: z.strictObject({ name: string, sizeBytes: size }).optional(),
  runtimeImages: images,
  toolImages: images,
};
const v2 = {
  sourceFingerprints: z.array(z.strictObject({ id: string, sha256: digest, sizeBytes: size })),
  artifactFingerprint: digest,
  credentialRequirements: z.array(string).optional(),
  runtimeMaterialization: z.literal("motis-target-credentials").optional(),
};
export const buildRecordSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({ schemaVersion: z.literal(1), ...common }),
  z.strictObject({ schemaVersion: z.literal(2), ...common, ...v2 }),
]);
const layout = {
  dirs: z.array(string),
  directories: z.array(string),
  files: z.array(z.strictObject({ path: string, sizeBytes: size, sha256: digest })),
};
const schema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({ schemaVersion: z.literal(1), ...common, ...layout }),
  z.strictObject({ schemaVersion: z.literal(2), ...common, ...v2, ...layout }),
]);

export { artifactFingerprint, safeArtifactPath } from "./artifact-path";
export function parseBundleManifest(text: string): BundleManifest {
  const result = schema.safeParse(JSON.parse(text));
  if (!result.success) throw Error("Bundle manifest is malformed");
  const m = result.data;
  const spec = buildArtifactSpec(m.service);
  if (JSON.stringify([...m.dirs].sort()) !== JSON.stringify([...spec.dirs].sort()))
    throw Error("Bundle artifact dirs do not match service");
  const names = new Set<string>();
  for (const name of [...m.directories, ...m.files.map((f) => f.path)]) {
    if (!safeArtifactPath(name) || !spec.dirs.some((d) => name === d || name.startsWith(`${d}/`)))
      throw Error("Bundle lists a path outside its artifact");
    if (names.has(name)) throw Error("Duplicate bundle manifest path");
    names.add(name);
  }
  const dirs = new Set(m.directories);
  for (const d of spec.dirs) if (!dirs.has(d)) throw Error("Bundle is missing artifact directory");
  for (const name of names) {
    const parent = name.split("/").slice(0, -1).join("/");
    if (
      parent &&
      spec.dirs.some((d) => parent === d || parent.startsWith(`${d}/`)) &&
      !dirs.has(parent)
    )
      throw Error("Bundle missing parent directory");
  }
  if (!m.runtimeImages[m.service])
    throw Error("Bundle has no runtime image binding; rebuild with the runtime image");
  if (m.schemaVersion === 2) {
    if (
      new Set(m.sourceFingerprints.map((f) => f.id)).size !== m.sourceFingerprints.length ||
      new Set(m.credentialRequirements).size !== (m.credentialRequirements?.length ?? 0)
    )
      throw Error("Duplicate source or credential ID");
    if (m.artifactFingerprint !== artifactFingerprint(m.files))
      throw Error("Bundle artifact fingerprint failed verification");
    if ((m.runtimeMaterialization || m.credentialRequirements) && m.service !== "motis")
      throw Error("Invalid credential materialization service");
  }
  if (
    m.service === "motis" &&
    m.files.some(
      (f) =>
        f.path.startsWith("motis-feed-proxy/") ||
        /(?:^|\/)(?:feed-proxy-vars\.json|api-keys\.json|config\.yml)$/.test(f.path),
    )
  )
    throw Error(
      "Legacy credential-bearing MOTIS bundle: rebuild a portable candidate from retained source metadata and materialize target credentials before readiness",
    );
  return m;
}
export async function runtimeImageMismatches(
  runtimeImages: Record<string, string>,
  rootDir: string,
): Promise<ImageMismatch[]> {
  const registry = new ServiceRegistry({ rootDir });
  await registry.load();
  return Object.entries(runtimeImages).flatMap(([service, bundle]) => {
    const loaded = registry.get(service);
    const local = loaded
      ? serviceContainerImageReference(loaded.manifest.container)
      : "(not installed)";
    return local === bundle ? [] : [{ service, bundle, local }];
  });
}

export const portableMotisSourcesSchema = z.strictObject({
  recipe: portableMotisRecipeSchema.optional(),
  version: z.literal(1),
  sourceFingerprints: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(512),
        sha256: digest,
        sizeBytes: size,
      }),
    )
    .max(10000),
  credentialRequirements: z.array(z.string().min(1).max(512)).max(1000),
});
