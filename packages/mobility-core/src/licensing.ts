/** Portable, captured licence identity. Presentation never grants usage rights. */
import parseExpression, { type Info as Expression } from "spdx-expression-parse";
import spdxLicenseList from "spdx-license-list";

export const LICENSE_SCOPES = ["data", "imagery", "style", "software", "service"] as const;
export type LicenseScope = (typeof LICENSE_SCOPES)[number];
export type LicenseDescriptor =
  | { kind: "spdx"; expression: string; url?: string }
  | { kind: "custom"; id: string; namespace: string; name: string; url?: string; version?: string }
  | { kind: "unknown"; raw?: string; url?: string }
  | { kind: "per-item"; raw?: string; url?: string }
  | { kind: "public-domain"; name: string; url?: string }
  | { kind: "status"; id: "CC-PDM-1.0"; url?: string };
export const ATTRIBUTION_SURFACES = ["map", "content", "image"] as const;
export type AttributionSurface = (typeof ATTRIBUTION_SURFACES)[number];
export const ATTRIBUTION_LOGOS = ["openweather", "mapillary", "maptiler", "tdx"] as const;
export type AttributionLogo = (typeof ATTRIBUTION_LOGOS)[number];
/** Reviewed display policy, never a grant of data or API permissions. */
export interface AttributionPolicy {
  placement: "visible" | "details";
  surfaces: readonly AttributionSurface[];
  basis: "licence" | "provider-terms" | "recommendation" | "unresolved";
  reviewedAt: string;
  evidenceUrls: readonly string[];
  reason: string;
  /** Explicitly reviewed minimal visible wording; the complete notice is retained. */
  compactText?: string;
  /** Reviewed local branding asset, never a URL supplied by an extension. */
  logo?: AttributionLogo;
  prominence?: "normal";
  /** Preserve the actual record publisher beside the visible service credit. */
  includePublisher?: true;
}
export interface LicenseBinding {
  scope: LicenseScope;
  subject: string;
  license: LicenseDescriptor;
  notice?: string;
  conditions?: readonly string[];
  attribution?: AttributionPolicy;
}
export interface Licensing {
  version: 1;
  bindings: readonly LicenseBinding[];
  /** Original supplier declarations are evidence, never display identity or permissions. */
  declarations?: readonly { text?: string; url?: string }[];
}
export interface LicensingDisplayOptions {
  fullNames?: boolean;
  scopes?: readonly LicenseScope[];
}
export interface LicensePresentation {
  scope: LicenseScope;
  subject: string;
  label: string;
  url?: string;
  licenses?: { label: string; url?: string }[];
  notice?: string;
  conditions?: readonly string[];
}
export const DISPLAY_LICENSE_SCOPES: readonly LicenseScope[] = [
  "data",
  "imagery",
  "style",
  "service",
];
const DATA_SCOPES: readonly LicenseScope[] = ["data", "imagery", "style"];
const IDS = new Map(Object.keys(spdxLicenseList).map((id) => [id.toLowerCase(), id]));
const NAMES = new Map(
  Object.entries(spdxLicenseList).map(([id, entry]) => [entry.name.toLowerCase(), id]),
);
const LICENSE_REF = /^LicenseRef-[A-Za-z0-9.-]+$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9:./_-]{0,255}$/;

export function canonicalSpdxId(value: string): string | undefined {
  return IDS.get(value.trim().toLowerCase());
}

function expressionTree(raw: string): Expression | undefined {
  if (!raw.trim() || raw.length > 1_000 || (raw.match(/\(/g)?.length ?? 0) > 32) return undefined;
  const singleId = canonicalSpdxId(raw);
  if (singleId) return { license: singleId };
  const canonical = raw.replace(
    /[A-Za-z0-9][A-Za-z0-9.-]*/g,
    (token) => canonicalSpdxId(token) ?? token,
  );
  try {
    const tree = parseExpression(canonical);
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if ("license" in node) {
        // Custom references require a captured definition, not the standard list.
        if (!canonicalSpdxId(node.license)) return undefined;
      } else pending.push(node.left, node.right);
    }
    return tree;
  } catch {
    return undefined;
  }
}

function printExpression(node: Expression, fullNames = false, parentPriority = 0): string {
  if ("license" in node) {
    const id = canonicalSpdxId(node.license)!;
    return `${fullNames ? spdxLicenseList[id].name : id}${node.plus ? "+" : ""}${node.exception ? ` WITH ${node.exception}` : ""}`;
  }
  const priority = node.conjunction === "and" ? 2 : 1;
  const text = `${printExpression(node.left, fullNames, priority)} ${node.conjunction.toUpperCase()} ${printExpression(node.right, fullNames, priority)}`;
  return priority < parentPriority ? `(${text})` : text;
}

/** Validate the whole standard expression; never select its first matching atom. */
export function canonicalLicenseExpression(raw: string): string | undefined {
  const tree = expressionTree(raw);
  return tree ? printExpression(tree) : undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 1_000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const optionalText = (value: unknown, max = 1_000): value is string | undefined =>
  value === undefined || text(value, max);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const CREDENTIAL_PARAMETERS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "client_secret",
  "credential",
  "key",
  "password",
  "secret",
  "sig",
  "signature",
  "token",
  "x-amz-signature",
  "x-goog-signature",
]);
export function isSafeAttributionUrl(value: unknown): value is string {
  if (!text(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((key) => CREDENTIAL_PARAMETERS.has(key.toLowerCase()))
    );
  } catch {
    return false;
  }
}
const safeUrl = (value: unknown): value is string | undefined =>
  value === undefined || isSafeAttributionUrl(value);

export function parseAttributionPolicy(raw: unknown): AttributionPolicy | undefined {
  if (
    !record(raw) ||
    !keys(raw, [
      "placement",
      "surfaces",
      "basis",
      "reviewedAt",
      "evidenceUrls",
      "reason",
      "compactText",
      "logo",
      "prominence",
      "includePublisher",
    ]) ||
    !["visible", "details"].includes(String(raw.placement)) ||
    !["licence", "provider-terms", "recommendation", "unresolved"].includes(String(raw.basis)) ||
    (raw.placement === "details" && raw.basis === "unresolved") ||
    (raw.basis === "unresolved" && raw.compactText !== undefined) ||
    !Array.isArray(raw.surfaces) ||
    raw.surfaces.length === 0 ||
    raw.surfaces.length > 3 ||
    new Set(raw.surfaces).size !== raw.surfaces.length ||
    !raw.surfaces.every((surface) => ATTRIBUTION_SURFACES.includes(surface)) ||
    !text(raw.reviewedAt) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.reviewedAt) ||
    !Number.isFinite(Date.parse(raw.reviewedAt)) ||
    new Date(raw.reviewedAt).toISOString().slice(0, 10) !== raw.reviewedAt ||
    !Array.isArray(raw.evidenceUrls) ||
    raw.evidenceUrls.length === 0 ||
    raw.evidenceUrls.length > 8 ||
    !raw.evidenceUrls.every(isSafeAttributionUrl) ||
    !text(raw.reason, 2_000) ||
    !optionalText(raw.compactText, 2_000) ||
    (raw.logo !== undefined && !ATTRIBUTION_LOGOS.includes(raw.logo as AttributionLogo)) ||
    (raw.prominence !== undefined && raw.prominence !== "normal") ||
    (raw.includePublisher !== undefined && raw.includePublisher !== true) ||
    (raw.placement !== "visible" &&
      (raw.compactText !== undefined ||
        raw.logo !== undefined ||
        raw.prominence !== undefined ||
        raw.includePublisher !== undefined))
  )
    return undefined;
  return {
    placement: raw.placement as AttributionPolicy["placement"],
    surfaces: [...raw.surfaces] as AttributionSurface[],
    basis: raw.basis as AttributionPolicy["basis"],
    reviewedAt: raw.reviewedAt,
    evidenceUrls: [...raw.evidenceUrls] as string[],
    reason: raw.reason,
    ...(raw.compactText === undefined ? {} : { compactText: raw.compactText }),
    ...(raw.logo === undefined ? {} : { logo: raw.logo as AttributionLogo }),
    ...(raw.prominence === undefined ? {} : { prominence: "normal" as const }),
    ...(raw.includePublisher === undefined ? {} : { includePublisher: true as const }),
  };
}

function parseDescriptor(raw: unknown): LicenseDescriptor | undefined {
  if (!record(raw) || !safeUrl(raw.url)) return undefined;
  const url = raw.url === undefined ? {} : { url: raw.url };
  switch (raw.kind) {
    case "spdx": {
      if (!keys(raw, ["kind", "expression", "url"]) || !text(raw.expression)) return undefined;
      const expression = canonicalLicenseExpression(raw.expression);
      // A Public Domain Mark is evidence of status, rather than a grant.
      return expression && !expression.includes("CC-PDM-1.0")
        ? { kind: "spdx", expression, ...url }
        : undefined;
    }
    case "custom":
      return keys(raw, ["kind", "id", "namespace", "name", "url", "version"]) &&
        text(raw.id) &&
        LICENSE_REF.test(raw.id) &&
        text(raw.namespace) &&
        NAMESPACE.test(raw.namespace) &&
        text(raw.name) &&
        optionalText(raw.version)
        ? {
            kind: "custom",
            id: raw.id,
            namespace: raw.namespace,
            name: raw.name,
            ...url,
            ...(raw.version === undefined ? {} : { version: raw.version }),
          }
        : undefined;
    case "unknown":
    case "per-item":
      return keys(raw, ["kind", "raw", "url"]) && optionalText(raw.raw)
        ? { kind: raw.kind, ...(raw.raw === undefined ? {} : { raw: raw.raw }), ...url }
        : undefined;
    case "public-domain":
      return keys(raw, ["kind", "name", "url"]) && text(raw.name)
        ? { kind: "public-domain", name: raw.name, ...url }
        : undefined;
    case "status":
      return keys(raw, ["kind", "id", "url"]) && raw.id === "CC-PDM-1.0"
        ? { kind: "status", id: "CC-PDM-1.0", ...url }
        : undefined;
    default:
      return undefined;
  }
}

/** Strict, bounded validation and deep copy at every portable receipt boundary. */
export function parseLicensing(raw: unknown): Licensing | undefined {
  if (
    !record(raw) ||
    !keys(raw, ["version", "bindings", "declarations"]) ||
    raw.version !== 1 ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length > 64
  )
    return undefined;
  let declarations: { text?: string; url?: string }[] | undefined;
  if (raw.declarations !== undefined) {
    if (!Array.isArray(raw.declarations) || raw.declarations.length > 64) return undefined;
    declarations = [];
    for (const value of raw.declarations) {
      if (
        !record(value) ||
        !keys(value, ["text", "url"]) ||
        !optionalText(value.text) ||
        !safeUrl(value.url) ||
        (value.text === undefined && value.url === undefined)
      )
        return undefined;
      declarations.push({
        ...(value.text === undefined ? {} : { text: value.text }),
        ...(value.url === undefined ? {} : { url: value.url }),
      });
    }
  }
  const bindings: LicenseBinding[] = [];
  for (const binding of raw.bindings) {
    if (
      !record(binding) ||
      !keys(binding, ["scope", "subject", "license", "notice", "conditions", "attribution"]) ||
      !LICENSE_SCOPES.includes(binding.scope as LicenseScope) ||
      !text(binding.subject) ||
      !optionalText(binding.notice, 16_000)
    )
      return undefined;
    const license = parseDescriptor(binding.license);
    if (!license) return undefined;
    const attribution =
      binding.attribution === undefined ? undefined : parseAttributionPolicy(binding.attribution);
    if (binding.attribution !== undefined && !attribution) return undefined;
    const conditions = binding.conditions;
    if (
      conditions !== undefined &&
      (!Array.isArray(conditions) ||
        conditions.length > 32 ||
        !conditions.every((condition) => text(condition)))
    )
      return undefined;
    bindings.push({
      scope: binding.scope as LicenseScope,
      subject: binding.subject,
      license,
      ...(binding.notice === undefined ? {} : { notice: binding.notice }),
      ...(attribution === undefined ? {} : { attribution }),
      ...(conditions === undefined ? {} : { conditions: [...conditions] as string[] }),
    });
  }
  return { version: 1, bindings, ...(declarations === undefined ? {} : { declarations }) };
}

function licenceAtoms(tree: Expression): { label: string; url?: string }[] {
  if ("license" in tree) {
    const id = canonicalSpdxId(tree.license)!;
    return [
      { label: id, url: spdxLicenseList[id].url },
      ...(tree.exception
        ? [{ label: tree.exception, url: `https://spdx.org/licenses/${tree.exception}.html` }]
        : []),
    ];
  }
  return [...licenceAtoms(tree.left), ...licenceAtoms(tree.right)];
}

export function licensingLinks(
  licensing: Licensing,
  options: LicensingDisplayOptions = {},
): LicensePresentation[] {
  const captured = parseLicensing(licensing);
  if (!captured) return [];
  return captured.bindings
    .filter((binding) => !options.scopes || options.scopes.includes(binding.scope))
    .map((binding) => {
      const { license } = binding;
      let label: string;
      let url: string | undefined;
      let licenses: { label: string; url?: string }[] | undefined;
      if (license.kind === "spdx") {
        const tree = expressionTree(license.expression)!;
        label = printExpression(tree, options.fullNames);
        licenses = [...new Map(licenceAtoms(tree).map((atom) => [atom.label, atom])).values()];
        url = license.url ?? (licenses.length === 1 ? licenses[0].url : undefined);
      } else if (license.kind === "custom" || license.kind === "public-domain") {
        label = license.name;
        url = license.url;
      } else if (license.kind === "status") {
        label = options.fullNames
          ? "Creative Commons Public Domain Mark 1.0 Universal"
          : license.id;
        url = license.url ?? "https://creativecommons.org/publicdomain/mark/1.0/";
      } else {
        label =
          license.raw ??
          (license.kind === "per-item" ? "Per-item licence" : "Licence not specified");
        url = license.url;
      }
      return {
        scope: binding.scope,
        subject: binding.subject,
        label,
        ...(url === undefined ? {} : { url }),
        ...(licenses === undefined ? {} : { licenses }),
        ...(binding.notice === undefined ? {} : { notice: binding.notice }),
        ...(binding.conditions === undefined ? {} : { conditions: binding.conditions }),
      };
    });
}

/** Captured reference links absent from the structured grants; never inferred permissions. */
export function licensingReferenceUrls(licensing: Licensing): string[] {
  const captured = parseLicensing(licensing);
  if (!captured) return [];
  const represented = new Set(
    licensingLinks(captured).flatMap((binding) => [
      binding.url,
      ...(binding.licenses && binding.licenses.length > 1
        ? binding.licenses.map((license) => license.url)
        : []),
    ]),
  );
  return [
    ...new Set(
      captured.declarations?.flatMap(({ url }) => (url && !represented.has(url) ? [url] : [])) ??
        [],
    ),
  ];
}

export function formatLicensing(
  licensing: Licensing,
  options: LicensingDisplayOptions = {},
): string {
  const parts = licensingLinks(licensing, options);
  return parts
    .map((part) => (parts.length > 1 ? `${part.subject}: ${part.label}` : part.label))
    .join("; ");
}

/** Query an exact content grant without conflating multiple subjects. */
export function dataLicenseExpression(licensing: Licensing): string | undefined {
  const eligible = parseLicensing(licensing)?.bindings.filter((binding) =>
    DATA_SCOPES.includes(binding.scope),
  );
  return eligible?.length === 1 && eligible[0].license.kind === "spdx"
    ? eligible[0].license.expression
    : undefined;
}

/** Exact, version-aware external declaration recognition; never substring matching. */
export function licenseIdFromDeclaration(raw: string): string | undefined {
  const trimmed = raw.trim();
  const direct = canonicalSpdxId(trimmed) ?? NAMES.get(trimmed.toLowerCase());
  if (direct) return direct;
  const normalized = trimmed.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
  const german =
    /^datenlizenz deutschland\s*(?:-\s*)?(zero|namensnennung)\s*(?:-\s*)?(?:version\s+)?2\.0$/.exec(
      normalized,
    );
  if (german) return german[1] === "zero" ? "DL-DE-ZERO-2.0" : "DL-DE-BY-2.0";
  const aliases: Record<string, string> = {
    "dl-de/by-2-0": "DL-DE-BY-2.0",
    "dl-de/zero-2-0": "DL-DE-ZERO-2.0",
    "cc 0 1.0": "CC0-1.0",
    "cc0 1.0": "CC0-1.0",
    "cc-0": "CC0-1.0",
    "creative commons namensnennung - 4.0 international (cc-by 4.0)": "CC-BY-4.0",
    "open government licence - canada": "OGL-Canada-2.0",
    "open government licence - canada 2.0": "OGL-Canada-2.0",
    "open government licence v3.0": "OGL-UK-3.0",
  };
  if (aliases[normalized]) return aliases[normalized];
  const shorthand =
    /^(cc[- ]by(?:[- ](?:sa|nd|nc|nc-sa|nc-nd))?|cc0|odbl|nLOD|apache(?: license)?)\s+(\d+\.\d+)(?:\s+(at|de|fr|uk|us))?$/i.exec(
      trimmed,
    );
  if (shorthand) {
    const candidate = `${shorthand[1].replace(/ /g, "-").replace(/-license$/i, "")}-${shorthand[2]}${shorthand[3] ? `-${shorthand[3]}` : ""}`;
    return canonicalSpdxId(candidate);
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const comparable = `${url.hostname}${url.pathname}`
      .replace(/\/(?:legalcode(?:\.en)?|deed(?:\.en)?)\/?$/, "")
      .replace(/\/$/, "");
    const publisherAliases: Record<string, string> = {
      "opendatacommons.org/licenses/odbl/1-0": "ODbL-1.0",
      "opendatacommons.org/licenses/pddl/1-0": "PDDL-1.0",
    };
    if (!url.search && publisherAliases[comparable]) return publisherAliases[comparable];
    for (const [id, entry] of Object.entries(spdxLicenseList)) {
      const known = new URL(entry.url);
      const target = `${known.hostname}${known.pathname}`
        .replace(/\/(?:legalcode(?:\.en)?|deed(?:\.en)?)\/?$/, "")
        .replace(/\/$/, "");
      if (comparable === target && !url.search) return id;
    }
  } catch {
    /* A raw declaration is not a URL. */
  }
  return undefined;
}

export function licensingFromDeclaration(
  raw?: string,
  url?: string,
  subject = "Data",
  scope: LicenseScope = "data",
): Licensing {
  const value = raw?.trim();
  const known = value
    ? (licenseIdFromDeclaration(value) ?? canonicalLicenseExpression(value))
    : url
      ? licenseIdFromDeclaration(url)
      : undefined;
  let license: LicenseDescriptor;
  if (known === "CC-PDM-1.0")
    license = { kind: "status", id: known, ...(safeUrl(url) && url ? { url } : {}) };
  else if (known)
    license = { kind: "spdx", expression: known, ...(safeUrl(url) && url ? { url } : {}) };
  else if (
    value &&
    /^(?:per[- ](?:file|item|operator)|mixed\b|varies\b|various\b|set by the feed operator)/i.test(
      value,
    )
  )
    license = { kind: "per-item", raw: value, ...(safeUrl(url) && url ? { url } : {}) };
  else if (value && /^(?:public domain|u\.s\. public domain)$/i.test(value))
    license = { kind: "public-domain", name: value, ...(safeUrl(url) && url ? { url } : {}) };
  else
    license = {
      kind: "unknown",
      ...(value ? { raw: value } : {}),
      ...(safeUrl(url) && url ? { url } : {}),
    };
  return {
    version: 1,
    bindings: [{ scope, subject, license }],
    ...(value || (safeUrl(url) && url)
      ? {
          declarations: [
            { ...(value ? { text: raw } : {}), ...(safeUrl(url) && url ? { url } : {}) },
          ],
        }
      : {}),
  };
}
