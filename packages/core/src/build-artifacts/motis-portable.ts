/** Offline MOTIS recipe. Bundle bytes never select a credential destination. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type FeedProxyVars,
  normalizeFeedProxyVars,
  renderFeedProxyNginxConfig,
} from "@openmapx/motis-feed-proxy-config";
import { parseMotisConfigExpectations } from "@openmapx/transitous-core";
import { canonicalFeedCredentialMap } from "@openmapx/transitous-core/feed-credentials";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { hashArtifactFile } from "./copy-tree";
import { AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";
import {
  CANDIDATE_MANIFEST_FILENAME,
  CANDIDATE_PROXY_DIRNAME,
  type MotisCandidateManifest,
  parseMotisCandidateManifest,
  verifyCandidateManifest,
} from "./motis-candidate";

export const PORTABLE_MOTIS_FILENAME = "portable-sources.json";
export const MAX_PORTABLE_MOTIS_BYTES = 1024 * 1024;
export const MAX_MOTIS_MATERIALIZATION_BYTES = 32 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/);
const routeSchema = z.strictObject({
  key: token,
  region: token,
  sourceName: token,
  endpoint: z.enum([
    "url",
    "realtime_trip_updates",
    "realtime_vehicle_positions",
    "realtime_alerts",
    "gbfs_auto_discovery",
  ]),
});
const portableSourceManifestSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  sources: z
    .array(
      z.strictObject({
        sourceId: z.string().min(1).max(512),
        region: token,
        name: token,
        format: z.enum(["gtfs", "netex"]),
        origin: z.literal("catalog"),
        license: z.record(z.string(), z.json()),
        transformations: z.array(z.string().max(512)).max(100),
        artifact: z.strictObject({
          relativePath: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(gtfs|netex)\.zip$/),
          sha256: digest,
          sizeBytes: z.number().int().nonnegative().safe(),
          modifiedAt: z.iso.datetime(),
        }),
      }),
    )
    .min(1)
    .max(10000),
  profileEvidence: z
    .strictObject({
      profile: z.string().max(256),
      credentialRefs: z.array(z.string().max(512)).max(1000).optional(),
    })
    .optional(),
});
export const portableMotisRecipeSchema = z.strictObject({
  version: z.literal(1),
  pins: z.strictObject({
    transitousCommit: z.string().regex(/^[a-f0-9]{40}$/),
    atlasCommit: z.string().regex(/^[a-f0-9]{40}$/),
  }),
  config: z.string().min(1).max(MAX_PORTABLE_MOTIS_BYTES),
  configSha256: digest,
  templateSha256: digest,
  candidate: z.unknown().transform((raw) => parseMotisCandidateManifest(JSON.stringify(raw))),
  sourceManifest: portableSourceManifestSchema,
  sourceIndex: z.json().optional(),
  routes: z.array(routeSchema).max(10000),
});
export type PortableMotisRecipe = z.infer<typeof portableMotisRecipeSchema>;
export interface MotisPortablePins {
  transitousCommit: string;
  atlasCommit: string;
}
/** Implementations read ONLY these exact commits from the fixed local cached repositories. */
export type MotisPinnedBlobReader = (
  repository: "catalog" | "atlas",
  commit: string,
  path: string,
) => Promise<string>;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const invalid = () =>
  Error("MOTIS portability requires a supported pinned, nonsecret source recipe");
function object(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(raw))
  )
    throw invalid();
  return raw as Record<string, unknown>;
}
function document(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_PORTABLE_MOTIS_BYTES) throw invalid();
  return object(JSON.parse(text));
}
/** Reject accidental credentials in attribution/config. Comments never survive YAML decoding. */
function publicDocument(raw: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) throw invalid();
  if (typeof raw === "string") {
    if (
      raw.length > 16384 ||
      /(?:ENC\[|-----BEGIN |[\r\n])/.test(raw) ||
      raw.includes(String.fromCharCode(0))
    )
      throw invalid();
    for (const match of raw.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      const url = new URL(match[0]);
      if (url.username || url.password || url.search || url.hash) throw invalid();
    }
  } else if (raw && typeof raw === "object") {
    if (seen.has(raw)) throw invalid();
    seen.add(raw);
    if (Array.isArray(raw)) for (const value of raw) publicDocument(value, depth + 1, seen);
    else
      for (const [key, value] of Object.entries(object(raw))) {
        if (/(?:auth|header|token|password|secret|api.?key)/i.test(key)) throw invalid();
        publicDocument(value, depth + 1, seen);
      }
    seen.delete(raw);
  } else if (raw !== null && typeof raw !== "boolean" && typeof raw !== "number") throw invalid();
}
function configRoutes(config: Record<string, unknown>, vars?: FeedProxyVars): Set<string> {
  const used = new Set<string>();
  const rewrite = (raw: unknown) => {
    const feed = object(raw);
    if (typeof feed.url !== "string") throw invalid();
    let key: string | undefined;
    if (vars) key = Object.entries(vars).find(([, value]) => value.url === feed.url)?.[0];
    if (!key) {
      const match = /^http:\/\/motis-feed-proxy\/feed\/([a-zA-Z0-9_.%-]+)$/.exec(feed.url);
      if (!match) throw invalid();
      key = decodeURIComponent(match[1]);
    }
    token.parse(key);
    if (!vars && feed.headers !== undefined) throw invalid();
    delete feed.headers;
    feed.url = `http://motis-feed-proxy/feed/${encodeURIComponent(key)}`;
    used.add(key);
  };
  const timetable = object(config.timetable),
    datasets = object(timetable.datasets);
  if (!Object.keys(datasets).length) throw invalid();
  for (const raw of Object.values(datasets)) {
    const dataset = object(raw);
    if (
      Object.keys(dataset).some(
        (key) => !["path", "extend_calendar", "default_timezone", "script", "rt"].includes(key),
      )
    )
      throw invalid();
    if (
      dataset.script !== undefined &&
      (typeof dataset.script !== "string" ||
        !/^scripts\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.lua$/.test(dataset.script))
    )
      throw invalid();
    if (
      typeof dataset.path !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(gtfs|netex)\.zip$/.test(dataset.path)
    )
      throw invalid();
    if (dataset.rt !== undefined) {
      if (!Array.isArray(dataset.rt)) throw invalid();
      for (const rt of dataset.rt) rewrite(rt);
    }
  }
  if (config.gbfs !== undefined && config.gbfs !== false) {
    const gbfs = object(config.gbfs);
    if (!vars && gbfs.proxy !== undefined && gbfs.proxy !== "http://motis-feed-proxy")
      throw invalid();
    if (gbfs.proxy !== undefined) gbfs.proxy = "http://motis-feed-proxy";
    for (const feed of Object.values(object(gbfs.feeds))) rewrite(feed);
  }
  if (
    config.osm !== undefined &&
    (typeof config.osm !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.osm\.pbf$/.test(config.osm))
  )
    throw invalid();
  const walk = (raw: unknown, key = ""): void => {
    if (key === "data_attribution_link") return;
    if (
      typeof raw === "string" &&
      /https?:\/\//.test(raw) &&
      raw !== "http://motis-feed-proxy" &&
      !/^http:\/\/motis-feed-proxy\/feed\/[a-zA-Z0-9_.%-]+$/.test(raw)
    )
      throw invalid();
    if (raw && typeof raw === "object")
      for (const [key, value] of Object.entries(raw)) walk(value, key);
  };
  // Recursion/cycle limits before the simpler URL walk.
  publicDocument(config);
  walk(config);
  return used;
}
function samePins(a: MotisPortablePins, b: MotisPortablePins) {
  if (a.transitousCommit !== b.transitousCommit || a.atlasCommit !== b.atlasCommit)
    throw Error("MOTIS destination catalog pins do not match the recipe");
}
interface ResolvedRoute {
  key: string;
  url: string;
  gbfs: boolean;
  credentialKey?: string;
  header?: string;
  basic?: boolean;
  headers?: Record<string, string>;
}
/** Selectors have no URLs; only approved destination Git blobs choose endpoints and auth. */
async function resolveRoutes(
  routes: PortableMotisRecipe["routes"],
  pins: MotisPortablePins,
  readBlob: MotisPinnedBlobReader,
): Promise<ResolvedRoute[]> {
  const cache = new Map<string, Promise<Record<string, unknown>>>();
  const read = (repo: "catalog" | "atlas", path: string) => {
    const id = `${repo}:${path}`;
    let value = cache.get(id);
    if (!value) {
      value = readBlob(
        repo,
        repo === "catalog" ? pins.transitousCommit : pins.atlasCommit,
        path,
      ).then(document);
      cache.set(id, value);
    }
    return value;
  };
  const result: ResolvedRoute[] = [];
  for (const route of routes) {
    const feed = await read("catalog", `feeds/${route.region}.json`);
    if (!Array.isArray(feed.sources)) throw invalid();
    const matches = feed.sources.map(object).filter((s) => s.name === route.sourceName);
    if (matches.length !== 1) throw invalid();
    const source = matches[0];
    if (source.skip === true || source["url-override"] || source["api-key"]) throw invalid();
    const prefix = `${route.region}-${route.sourceName}`;
    let url: unknown,
      authorization: Record<string, unknown> | undefined,
      headers: Record<string, string> | undefined,
      gbfs = false;
    if (source.type === "url" && route.endpoint === "url") {
      url = source.url;
      gbfs = source.spec === "gbfs";
      if (!gbfs && !["gtfs-rt", "siri-json"].includes(String(source.spec))) throw invalid();
      if (source.headers !== undefined) {
        const raw = object(source.headers);
        headers = {};
        for (const [key, value] of Object.entries(raw)) {
          if (
            typeof value !== "string" ||
            value.length > 8192 ||
            /ENC\[|[\r\n]/.test(value) ||
            value.includes(String.fromCharCode(0)) ||
            !/^[a-zA-Z0-9-]{1,128}$/.test(key)
          )
            throw invalid();
          headers[key] = value;
        }
      }
      if (route.key !== (gbfs ? prefix : `${prefix}-0`)) throw invalid();
    } else if (
      source.type === "transitland-atlas" &&
      typeof source["transitland-atlas-id"] === "string" &&
      route.endpoint !== "url"
    ) {
      // Atlas stores one DMFR per id. Resolve only the exact pinned file, never mutable working-tree content.
      const atlasId = source["transitland-atlas-id"];
      token.parse(atlasId);
      const dmfr = await read("atlas", `feeds/.openmapx-atlas-id/${atlasId}`);
      if (!Array.isArray(dmfr.feeds)) throw invalid();
      const entries = dmfr.feeds.map(object).filter((f) => f.id === atlasId);
      if (entries.length !== 1) throw invalid();
      const entry = entries[0],
        urls = object(entry.urls);
      url = urls[route.endpoint];
      gbfs = route.endpoint === "gbfs_auto_discovery";
      const rt = ["realtime_trip_updates", "realtime_vehicle_positions", "realtime_alerts"].filter(
        (k) => typeof urls[k] === "string",
      );
      if (route.key !== (gbfs ? prefix : `${prefix}-${rt.indexOf(route.endpoint)}`))
        throw invalid();
      if (entry.authorization !== undefined && entry.authorization !== null)
        authorization = object(entry.authorization);
    } else throw invalid();
    if (typeof url !== "string") throw invalid();
    const endpoint = new URL(url);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      /[\r\n]|ENC\[/.test(url) ||
      url.includes(String.fromCharCode(0))
    )
      throw invalid();
    const resolved: ResolvedRoute = { key: route.key, url, gbfs, ...(headers ? { headers } : {}) };
    if (authorization) {
      if (authorization.type !== "header" && authorization.type !== "basic_auth") throw invalid();
      const header =
        authorization.type === "basic_auth" ? "Authorization" : authorization.param_name;
      if (typeof header !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(header)) throw invalid();
      resolved.credentialKey = `${route.region}/${route.sourceName}`;
      resolved.header = header;
      resolved.basic = authorization.type === "basic_auth";
    }
    result.push(resolved);
  }
  return result;
}
function renderVars(
  routes: ResolvedRoute[],
  credentials: Readonly<Record<string, string>>,
): FeedProxyVars {
  canonicalFeedCredentialMap(credentials);
  const vars: FeedProxyVars = {};
  for (const route of routes) {
    const headers = { ...route.headers };
    if (route.credentialKey) {
      const value = credentials[route.credentialKey];
      if (!value) throw Error(`MOTIS destination credential is missing: ${route.credentialKey}`);
      if (/[\r\n]/.test(value) || value.includes(String.fromCharCode(0)))
        throw Error("MOTIS destination credential is unsafe for a proxy header");
      if (!route.header) throw invalid();
      headers[route.header] = `${route.basic ? "Basic " : ""}${value}`;
    }
    vars[route.key] = {
      url: route.url,
      gbfs: route.gbfs,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }
  return normalizeFeedProxyVars(vars);
}
function equalVars(a: FeedProxyVars, b: FeedProxyVars) {
  const canonical = (vars: FeedProxyVars) =>
    JSON.stringify(
      Object.entries(vars)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [
          k,
          v.url,
          v.gbfs === true,
          Object.entries(v.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ]),
    );
  return canonical(a) === canonical(b);
}
/** Static runtime fields come from the exact approved pinned template. Only
 * generator-owned dataset/GBFS nodes and documented scalar overrides vary. */
async function validatePinnedTemplate(
  config: Record<string, unknown>,
  pins: MotisPortablePins,
  readBlob: MotisPinnedBlobReader,
) {
  const template = await readBlob("catalog", pins.transitousCommit, "configs/motis/config.yml");
  if (Buffer.byteLength(template) > MAX_PORTABLE_MOTIS_BYTES) throw invalid();
  const base = object(loadYaml(template));
  const normalize = (raw: Record<string, unknown>) => {
    const value = structuredClone(raw);
    delete value.osm;
    delete value.tiles;
    if (typeof value.osr_footpath === "boolean") delete value.osr_footpath;
    if (value.elevators === false) delete value.elevators;
    const timetable = object(value.timetable);
    delete timetable.datasets;
    if (typeof timetable.incremental_rt_update === "boolean")
      delete timetable.incremental_rt_update;
    if (value.gbfs !== undefined && value.gbfs !== false) {
      const gbfs = object(value.gbfs);
      delete gbfs.feeds;
      delete gbfs.proxy;
    }
    return value;
  };
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(",")}}`
        : JSON.stringify(value);
  if (canonical(normalize(config)) !== canonical(normalize(base)))
    throw Error("MOTIS configuration does not match the approved pinned template");
  if (config.tiles !== undefined && canonical(config.tiles) !== canonical(base.tiles))
    throw invalid();
  return sha(template);
}
export async function inspectPortableMotisRecipe(input: {
  recipe: unknown;
  pins: MotisPortablePins;
  readBlob: MotisPinnedBlobReader;
}) {
  const recipe = portableMotisRecipeSchema.parse(input.recipe);
  if (Buffer.byteLength(JSON.stringify(recipe)) > MAX_PORTABLE_MOTIS_BYTES) throw invalid();
  samePins(recipe.pins, input.pins);
  if (sha(recipe.config) !== recipe.configSha256)
    throw Error("MOTIS portable configuration digest mismatch");
  const config = document(recipe.config);
  const used = configRoutes(config);
  if ((await validatePinnedTemplate(config, input.pins, input.readBlob)) !== recipe.templateSha256)
    throw Error("MOTIS pinned template digest mismatch");
  if (
    recipe.candidate.artifacts.config.sha256 !== recipe.configSha256 ||
    recipe.candidate.artifacts.config.sizeBytes !== Buffer.byteLength(recipe.config) ||
    JSON.stringify(recipe.candidate.expectations) !==
      JSON.stringify(parseMotisConfigExpectations(recipe.config))
  )
    throw Error("MOTIS portable config readiness evidence does not match its template");
  const names = recipe.routes.map((r) => r.key);
  if (
    new Set(names).size !== names.length ||
    names.length !== used.size ||
    names.some((key) => !used.has(key))
  )
    throw invalid();
  publicDocument(recipe.sourceManifest);
  if (recipe.sourceIndex !== undefined) publicDocument(recipe.sourceIndex);
  const sourceManifest = object(recipe.sourceManifest);
  if (sourceManifest.version !== 1 || !Array.isArray(sourceManifest.sources)) throw invalid();
  const sourceInventory = sourceManifest.sources.map((source) => object(object(source).artifact));
  const expected = recipe.candidate.artifacts.datasets;
  if (
    sourceInventory.length !== expected.length ||
    new Set(sourceInventory.map((a) => a.relativePath)).size !== sourceInventory.length ||
    expected.some(
      (file) =>
        !sourceInventory.some(
          (a) =>
            a.relativePath === file.path &&
            a.sha256 === file.sha256 &&
            a.sizeBytes === file.sizeBytes,
        ),
    )
  )
    throw Error("MOTIS source manifest does not match the candidate inventory");
  for (const source of recipe.sourceManifest.sources) {
    const feed = document(
      await input.readBlob("catalog", input.pins.transitousCommit, `feeds/${source.region}.json`),
    );
    if (!Array.isArray(feed.sources)) throw invalid();
    const matching = feed.sources.map(object).filter((entry) => entry.name === source.name);
    if (
      matching.length !== 1 ||
      matching[0].skip === true ||
      source.sourceId !==
        (matching[0]["openmapx-source-id"] ?? `catalog:${source.region}:${source.name}`) ||
      source.artifact.relativePath !== `${source.region}_${source.name}.${source.format}.zip`
    )
      throw Error("MOTIS source provenance does not match the approved pinned catalog");
  }
  const routes = await resolveRoutes(recipe.routes, input.pins, input.readBlob);
  return {
    recipe,
    routes,
    credentialRequirements: [
      ...new Set(routes.flatMap((r) => (r.credentialKey ? [r.credentialKey] : []))),
    ].sort(),
  };
}
/** Run only after the actual successful candidate manifest has been built. */
export async function producePortableMotisRecipe(input: {
  stagingDir: string;
  pins: MotisPortablePins;
  readBlob: MotisPinnedBlobReader;
  credentials: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<void> {
  const candidate = await verifyCandidateManifest(input.stagingDir, input.signal);
  const root = new AnchoredDirectory(realpathSync(input.stagingDir));
  try {
    const read = (path: string) => {
      const parts = path.split("/"),
        file = parts.pop(),
        opened: AnchoredDirectory[] = [];
      let dir = root;
      if (!file) throw invalid();
      try {
        for (const part of parts) {
          dir = dir.directory(part);
          opened.push(dir);
        }
        return dir.read(file, MAX_PORTABLE_MOTIS_BYTES, false).toString("utf8");
      } finally {
        for (const dir of opened.reverse()) dir.close();
      }
    };
    const actualVars = normalizeFeedProxyVars(
      JSON.parse(read(`${CANDIDATE_PROXY_DIRNAME}/feed-proxy-vars.json`)),
    );
    const config = object(loadYaml(read("config.yml")));
    const used = configRoutes(config, actualVars);
    const routes: PortableMotisRecipe["routes"] = [];
    // Locate each actual key using the pinned catalog source names, not bundle supplied endpoints.
    for (const key of [...used].sort()) {
      const found = new Map<string, PortableMotisRecipe["routes"][number]>();
      for (let split = key.indexOf("-"); split > 0; split = key.indexOf("-", split + 1)) {
        const region = key.slice(0, split),
          suffix = key.slice(split + 1);
        for (const sourceName of new Set([suffix, suffix.replace(/-\d+$/, "")])) {
          if (!token.safeParse(region).success || !token.safeParse(sourceName).success) continue;
          for (const endpoint of [
            "url",
            "realtime_trip_updates",
            "realtime_vehicle_positions",
            "realtime_alerts",
            "gbfs_auto_discovery",
          ] as const) {
            const proposed = { key, region, sourceName, endpoint };
            try {
              const resolved = await resolveRoutes([proposed], input.pins, input.readBlob);
              const expected = renderVars(resolved, input.credentials);
              if (equalVars(expected, { [key]: actualVars[key] })) {
                found.set(JSON.stringify(proposed), proposed);
              }
            } catch {
              /* Unsupported selector: try the next exact pinned source identity. */
            }
          }
        }
      }
      if (found.size !== 1) throw invalid();
      routes.push([...found.values()][0]);
    }
    const sourceManifest = document(read("transit-source-manifest.json"));
    if (Array.isArray(sourceManifest.sources))
      for (const raw of sourceManifest.sources) delete object(raw).originUrl;
    publicDocument(sourceManifest);
    publicDocument(JSON.parse(read("license.json")));
    const configText = JSON.stringify(config);
    // Expectations can themselves contain source URLs. Derive them again from
    // the sanitized template, never retain the source candidate's raw URLs.
    candidate.expectations = parseMotisConfigExpectations(configText);
    const emptyHash = { sha256: sha(""), sizeBytes: 0 };
    candidate.artifacts.config = {
      ...candidate.artifacts.config,
      sha256: sha(configText),
      sizeBytes: Buffer.byteLength(configText),
    };
    candidate.artifacts.proxyConfig = { ...candidate.artifacts.proxyConfig, ...emptyHash };
    candidate.artifacts.proxyVars = { ...candidate.artifacts.proxyVars, ...emptyHash };
    publicDocument(candidate);
    for (const dataset of Object.values(object(object(config.timetable).datasets))) {
      const script = object(dataset).script;
      if (
        typeof script === "string" &&
        read(script) !== (await input.readBlob("catalog", input.pins.transitousCommit, script))
      )
        throw Error("MOTIS candidate script does not match its approved pin");
    }
    const recipe = portableMotisRecipeSchema.parse({
      version: 1,
      pins: input.pins,
      config: configText,
      configSha256: sha(configText),
      templateSha256: await validatePinnedTemplate(config, input.pins, input.readBlob),
      candidate,
      sourceManifest,
      ...(candidate.artifacts.sourceIndex
        ? { sourceIndex: JSON.parse(read("gbfs-source-index.json")) }
        : {}),
      routes,
    });
    const inspected = await inspectPortableMotisRecipe({
      recipe,
      pins: input.pins,
      readBlob: input.readBlob,
    });
    if (
      !equalVars(
        renderVars(inspected.routes, input.credentials),
        Object.fromEntries([...used].map((key) => [key, actualVars[key]])),
      )
    )
      throw invalid();
    const sourceFingerprints = candidate.artifacts.datasets.map((f) => ({
      id: f.path,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
    }));
    const metadata = {
      version: 1,
      sourceFingerprints,
      credentialRequirements: inspected.credentialRequirements,
      recipe,
    };
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized) > MAX_PORTABLE_MOTIS_BYTES) throw invalid();
    for (const value of Object.values(input.credentials))
      if (value && serialized.includes(value)) throw invalid();
    input.signal?.throwIfAborted();
    root.write(PORTABLE_MOTIS_FILENAME, `${serialized}\n`);
  } finally {
    root.close();
  }
}
/** Stage is a private owned extracted candidate. This has no network or lifecycle effects. */
export async function materializePortableMotisCandidate(input: {
  archiveFingerprint: string;
  stagingDir: string;
  recipe: unknown;
  pins: MotisPortablePins;
  readBlob: MotisPinnedBlobReader;
  credentials: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<{
  manifest: MotisCandidateManifest;
  materialization: VerifiedPortableMotisMaterialization;
}> {
  digest.parse(input.archiveFingerprint);
  input.signal?.throwIfAborted();
  const { recipe, routes } = await inspectPortableMotisRecipe(input);
  const vars = renderVars(routes, input.credentials),
    root = new AnchoredDirectory(realpathSync(input.stagingDir));
  const inode = identity(root.stat);
  let metadataSha256: string;
  const generated = new Map<string, string>();
  let manifest: MotisCandidateManifest;
  try {
    const metadataBytes = root.read(PORTABLE_MOTIS_FILENAME, MAX_PORTABLE_MOTIS_BYTES, false),
      retained = object(JSON.parse(metadataBytes.toString("utf8")));
    if (JSON.stringify(portableMotisRecipeSchema.parse(retained.recipe)) !== JSON.stringify(recipe))
      throw Error("MOTIS materialization recipe does not match its retained portable metadata");
    metadataSha256 = sha(metadataBytes);
    const a = recipe.candidate.artifacts;
    for (const expected of [a.license, ...a.datasets]) {
      const actual = await hashArtifactFile(root, expected.path, input.signal);
      if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes)
        throw Error(`MOTIS portable candidate integrity mismatch: ${expected.path}`);
    }
    const config = document(recipe.config),
      datasets = Object.values(object(object(config.timetable).datasets)).map(
        (d) => object(d).path,
      );
    if (
      JSON.stringify([...datasets].sort()) !== JSON.stringify(a.datasets.map((d) => d.path).sort())
    )
      throw Error("MOTIS portable configuration does not match the compiled source inventory");
    if (typeof config.osm === "string") await hashArtifactFile(root, config.osm, input.signal);
    const varsText = JSON.stringify(vars);
    // Conservatively fence render expansion before allocating the nginx output.
    if (Buffer.byteLength(varsText) * 3 + routes.length * 2048 > MAX_MOTIS_MATERIALIZATION_BYTES)
      throw Error("MOTIS materialization exceeds its reserved byte budget");
    generated.set("config.yml", recipe.config);
    generated.set("transit-source-manifest.json", JSON.stringify(recipe.sourceManifest));
    if (recipe.sourceIndex !== undefined)
      generated.set("gbfs-source-index.json", JSON.stringify(recipe.sourceIndex));
    generated.set(`${CANDIDATE_PROXY_DIRNAME}/feed-proxy-vars.json`, varsText);
    generated.set(`${CANDIDATE_PROXY_DIRNAME}/conf/default.conf`, renderFeedProxyNginxConfig(vars));
    for (const dataset of Object.values(object(object(config.timetable).datasets))) {
      const script = object(dataset).script;
      if (typeof script === "string") {
        const bytes = await input.readBlob("catalog", input.pins.transitousCommit, script);
        if (Buffer.byteLength(bytes) > MAX_PORTABLE_MOTIS_BYTES) throw invalid();
        generated.set(script, bytes);
      }
    }
    const hash = (path: string) => {
      const bytes = generated.get(path);
      if (bytes === undefined) throw invalid();
      return { path, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes) };
    };
    manifest = {
      ...recipe.candidate,
      expectations: parseMotisConfigExpectations(recipe.config),
      artifacts: {
        ...a,
        config: hash("config.yml"),
        proxyConfig: hash(`${CANDIDATE_PROXY_DIRNAME}/conf/default.conf`),
        proxyVars: hash(`${CANDIDATE_PROXY_DIRNAME}/feed-proxy-vars.json`),
        sourceManifest: hash("transit-source-manifest.json"),
        ...(recipe.sourceIndex === undefined
          ? {}
          : { sourceIndex: hash("gbfs-source-index.json") }),
      },
    };
    generated.set(CANDIDATE_MANIFEST_FILENAME, JSON.stringify(manifest));
    if (
      [...generated.values()].reduce((total, bytes) => total + Buffer.byteLength(bytes), 0) >
      MAX_MOTIS_MATERIALIZATION_BYTES
    )
      throw Error("MOTIS materialization exceeds its reserved byte budget");
    // No writes occur until every credential, pinned script, source integrity
    // check and the complete fixed reservation has passed.
    for (const [path, bytes] of generated) {
      input.signal?.throwIfAborted();
      const parts = path.split("/"),
        file = parts.pop();
      if (!file) throw invalid();
      const opened: AnchoredDirectory[] = [];
      let directory = root;
      try {
        for (const part of parts) {
          directory = directory.directory(part, true);
          opened.push(directory);
        }
        directory.write(file, bytes);
      } finally {
        for (const directory of opened.reverse()) directory.close();
      }
    }
  } finally {
    root.close();
  }
  manifest = await verifyCandidateManifest(input.stagingDir, input.signal);
  const proofRoot = new AnchoredDirectory(realpathSync(input.stagingDir)),
    generatedArtifacts = [];
  try {
    if (!sameInode(inode, identity(proofRoot.stat))) throw invalid();
    for (const [path, bytes] of generated) {
      const file = await hashArtifactFile(proofRoot, path, input.signal);
      if (file.sha256 !== sha(bytes) || file.sizeBytes !== Buffer.byteLength(bytes))
        throw Error("MOTIS generated artifact changed before materialization proof");
      generatedArtifacts.push(file);
    }
  } finally {
    proofRoot.close();
  }
  const materialization = Object.freeze({}) as VerifiedPortableMotisMaterialization;
  materializations.set(materialization, {
    inode,
    metadataSha256,
    archiveFingerprint: input.archiveFingerprint,
    generatedArtifacts,
    manifestDigest: sha(JSON.stringify(manifest)),
    sourceFingerprints: recipe.candidate.artifacts.datasets.map((file) => ({
      id: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    })),
  });
  return { manifest, materialization };
}

declare const materializationBrand: unique symbol;
export type VerifiedPortableMotisMaterialization = Readonly<{ [materializationBrand]: true }>;
const materializations = new WeakMap<
  object,
  {
    inode: FileIdentity;
    metadataSha256: string;
    archiveFingerprint: string;
    generatedArtifacts: Array<{ path: string; sha256: string; sizeBytes: number }>;
    manifestDigest: string;
    sourceFingerprints: Array<{ id: string; sha256: string; sizeBytes: number }>;
  }
>();
/** Only a successful materializer may authorize its exact generated files. */
export async function readVerifiedPortableMotisMaterialization(
  handle: VerifiedPortableMotisMaterialization,
  input: {
    stagingDir: string;
    archiveFingerprint: string;
    portableMetadataSha256: string;
    signal?: AbortSignal;
  },
) {
  const state = materializations.get(handle);
  if (
    !state ||
    state.archiveFingerprint !== input.archiveFingerprint ||
    state.metadataSha256 !== input.portableMetadataSha256
  )
    throw Error("Verified MOTIS materialization does not match its archive");
  const root = new AnchoredDirectory(realpathSync(input.stagingDir));
  try {
    if (
      !sameInode(state.inode, identity(root.stat)) ||
      sha(root.read(PORTABLE_MOTIS_FILENAME, MAX_PORTABLE_MOTIS_BYTES, false)) !==
        state.metadataSha256
    )
      throw Error("Verified MOTIS materialization directory or source metadata changed");
    const manifest = await verifyCandidateManifest(input.stagingDir, input.signal);
    if (sha(JSON.stringify(manifest)) !== state.manifestDigest)
      throw Error("Verified MOTIS materialization manifest changed");
    const generatedArtifacts = [];
    for (const expected of state.generatedArtifacts) {
      const actual = await hashArtifactFile(root, expected.path, input.signal);
      if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes)
        throw Error("Verified MOTIS generated artifact changed");
      generatedArtifacts.push(actual);
    }
    return {
      manifest,
      generatedArtifacts,
      sourceFingerprints: structuredClone(state.sourceFingerprints),
      archiveFingerprint: state.archiveFingerprint,
    };
  } finally {
    root.close();
  }
}

/** Native Git is used only as a bounded object decoder; this never fetches or checks out. */
export function createMotisPinnedBlobReader(
  catalogDir: string,
  pins: MotisPortablePins,
  signal?: AbortSignal,
): MotisPinnedBlobReader {
  const root = realpathSync(catalogDir),
    atlas = join(root, "transitland-atlas");
  for (const path of [catalogDir, atlas]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  }
  const execute = promisify(execFile),
    cache = new Map<string, Promise<string>>();
  let bytes = 0,
    files = 0;
  const git = async (repository: string, args: string[]) => {
    signal?.throwIfAborted();
    try {
      const result = await execute(
        "git",
        [
          "--no-replace-objects",
          "--no-optional-locks",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.allow=never",
          "-C",
          repository,
          ...args,
        ],
        {
          signal,
          timeout: 30000,
          maxBuffer: MAX_PORTABLE_MOTIS_BYTES,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      return result.stdout;
    } catch {
      signal?.throwIfAborted();
      throw invalid();
    }
  };
  let verified: Promise<void> | undefined;
  const verify = () =>
    (verified ??= git(root, ["ls-tree", pins.transitousCommit, "--", "transitland-atlas"]).then(
      (line) => {
        if (line.trim() !== `160000 commit ${pins.atlasCommit}\ttransitland-atlas`) throw invalid();
      },
    ));
  return async (repository, commit, path) => {
    const expected = repository === "catalog" ? pins.transitousCommit : pins.atlasCommit;
    const selector = /^feeds\/\.openmapx-atlas-id\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(path);
    if (repository === "atlas" && selector) {
      if (commit !== expected || !/^[a-f0-9]{40}$/.test(commit)) throw invalid();
      await verify();
      const key = `atlas-id:${selector[1]}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = (async () => {
          const names = (
            await git(atlas, [
              "grep",
              "--no-textconv",
              "-l",
              "-F",
              "-e",
              JSON.stringify(selector[1]),
              commit,
              "--",
              "feeds",
            ])
          )
            .trim()
            .split("\n");
          if (names.length > 128) throw invalid();
          const matches: Record<string, unknown>[] = [];
          for (const name of names) {
            if (!name.startsWith(`${commit}:`)) throw invalid();
            const path = name.slice(commit.length + 1);
            if (!/^feeds\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.dmfr\.json$/.test(path)) throw invalid();
            if (++files > 10000) throw invalid();
            const text = await git(atlas, [
              "show",
              "--no-ext-diff",
              "--no-textconv",
              `${commit}:${path}`,
            ]);
            bytes += Buffer.byteLength(text);
            if (bytes > 32 * MAX_PORTABLE_MOTIS_BYTES) throw invalid();
            const parsed = document(text);
            if (!Array.isArray(parsed.feeds)) throw invalid();
            matches.push(...parsed.feeds.map(object).filter((feed) => feed.id === selector[1]));
          }
          if (matches.length !== 1) throw invalid();
          return JSON.stringify({ feeds: matches });
        })();
        cache.set(key, pending);
      }
      return pending;
    }
    if (
      commit !== expected ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      !(
        repository === "catalog"
          ? /^(?:feeds\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json|configs\/motis\/config\.yml|scripts\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.lua)$/
          : /^feeds\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.dmfr\.json$/
      ).test(path)
    )
      throw invalid();
    await verify();
    const key = `${repository}:${path}`;
    let pending = cache.get(key);
    if (!pending) {
      if (++files > 10000) throw invalid();
      pending = git(repository === "catalog" ? root : atlas, [
        "show",
        "--no-ext-diff",
        "--no-textconv",
        `${commit}:${path}`,
      ]).then((text) => {
        bytes += Buffer.byteLength(text);
        if (bytes > 32 * MAX_PORTABLE_MOTIS_BYTES) throw invalid();
        return text;
      });
      cache.set(key, pending);
    }
    return pending;
  };
}
