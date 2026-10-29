import { readFileSync, writeFileSync } from "node:fs";
import {
  type ExtensionManifest,
  extensionManifestSchema,
} from "@openmapx/extension-contracts/extension";

import { validateExtensionAuthoringInput } from "../extension-validation.js";

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
  /** Each "<artifactUrl>,<sha256>,<id>". */
  integration?: string[];
}

export type ExtensionManifestDoc = ExtensionManifest;

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
    if (!artifact || !sha256 || !id) {
      throw new Error(`--integration must be "<artifactUrl>,<sha256>,<id>" (got "${spec}")`);
    }
    return { artifact, sha256, id };
  });

  if (services.length + integrations.length === 0) {
    throw new Error("an extension must declare at least one --service or --integration");
  }

  const doc: ExtensionManifestDoc = { id: opts.id, name: opts.name, version: opts.version };
  if (opts.platform !== undefined) doc.platform = opts.platform;
  if (opts.description) doc.description = opts.description;
  if (opts.license) doc.license = opts.license;
  if (opts.homepage) doc.homepage = opts.homepage;
  if (services.length) doc.services = services;
  if (integrations.length) doc.integrations = integrations;
  const result = validateExtensionAuthoringInput(doc);
  if (!result.valid) throw new Error(result.errors.join("; "));
  return extensionManifestSchema.parse(doc);
}

export type BundleCommandOptions = Partial<BundleOptions> & { out: string; input?: string };
export function runBundle(opts: BundleCommandOptions): string {
  let doc: ExtensionManifest;
  if (opts.input) {
    const mixed = Object.entries(opts).some(
      ([key, value]) =>
        !["input", "out"].includes(key) &&
        value !== undefined &&
        (!Array.isArray(value) || value.length > 0),
    );
    if (mixed) throw new Error("Cannot combine --input with bundle metadata or component flags.");
    const raw: unknown = JSON.parse(readFileSync(opts.input, "utf8"));
    const result = validateExtensionAuthoringInput(raw);
    if (!result.valid) throw new Error(result.errors.join("; "));
    doc = extensionManifestSchema.parse(raw);
  } else {
    doc = buildExtensionManifest({
      ...opts,
      id: opts.id ?? "",
      name: opts.name ?? "",
      version: opts.version ?? "",
    });
  }
  writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  return opts.out;
}
