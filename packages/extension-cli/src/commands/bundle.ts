import { writeFileSync } from "node:fs";

export interface BundleOptions {
  id: string;
  name: string;
  version: string;
  platform?: string;
  description?: string;
  license?: string;
  homepage?: string;
  /** Each "<repo>,<ref>,<serviceId>" (ref optional → empty). */
  service?: string[];
  /** Each "<artifactUrl>,<sha256>,<id>" (sha256 optional → empty). */
  integration?: string[];
}

export interface ExtensionManifestDoc {
  id: string;
  name: string;
  version: string;
  platform?: string;
  description?: string;
  license?: string;
  homepage?: string;
  services?: Array<{ repo: string; ref?: string; service: string }>;
  integrations?: Array<{ artifact: string; sha256?: string; id: string }>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Pure assembler — turns CLI flags into a validated extension.json document. */
export function buildExtensionManifest(opts: BundleOptions): ExtensionManifestDoc {
  if (!ID_RE.test(opts.id)) throw new Error(`Invalid id "${opts.id}" (use lowercase, hyphenated)`);
  if (!opts.name) throw new Error("name is required");
  if (!opts.version) throw new Error("version is required");

  const services = (opts.service ?? []).map((spec) => {
    const [repo, ref, service] = spec.split(",").map((s) => s.trim());
    if (!repo || !service) {
      throw new Error(`--service must be "<repo>,<ref>,<serviceId>" (got "${spec}")`);
    }
    return ref ? { repo, ref, service } : { repo, service };
  });

  const integrations = (opts.integration ?? []).map((spec) => {
    const [artifact, sha256, id] = spec.split(",").map((s) => s.trim());
    if (!artifact || !id) {
      throw new Error(`--integration must be "<artifactUrl>,<sha256>,<id>" (got "${spec}")`);
    }
    return sha256 ? { artifact, sha256, id } : { artifact, id };
  });

  if (services.length + integrations.length === 0) {
    throw new Error("an extension must declare at least one --service or --integration");
  }

  const doc: ExtensionManifestDoc = { id: opts.id, name: opts.name, version: opts.version };
  if (opts.platform) doc.platform = opts.platform;
  if (opts.description) doc.description = opts.description;
  if (opts.license) doc.license = opts.license;
  if (opts.homepage) doc.homepage = opts.homepage;
  if (services.length) doc.services = services;
  if (integrations.length) doc.integrations = integrations;
  return doc;
}

export function runBundle(opts: BundleOptions & { out: string }): string {
  const doc = buildExtensionManifest(opts);
  writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  return opts.out;
}
