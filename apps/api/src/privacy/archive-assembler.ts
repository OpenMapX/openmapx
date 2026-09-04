import { createHash } from "node:crypto";
import { createTranslator, type Locale, locales, resolveLocale } from "@openmapx/i18n";
import type { ArchiveEntryInput, ArchiveWriteResult } from "./artifact-writer.js";
import { archivePathForLogicalId, type PrivacyArchiveWriter } from "./artifact-writer.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import type {
  CollectorSourcePart,
  CollectorSourcePartEntry,
  SubjectExportRecord,
} from "./collectors.js";
import { buildPrivacyResponseReport, type PrivacyResponseContext } from "./response-report.js";

const MAX_ASSEMBLY_RECORDS = 10_000_000;
const MAX_ASSEMBLY_MEMBER_BYTES = 512 * 1024 * 1024;

function json(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_ASSEMBLY_MEMBER_BYTES)
    throw new Error("privacy archive member exceeds bound");
  return bytes;
}

function articleRecord(record: SubjectExportRecord): Record<string, unknown> {
  const { id: sourceId, ...data } = record.data;
  return {
    ...data,
    ...(sourceId === undefined ? {} : { sourceId }),
    id: record.id,
    policyCodes: record.policyCodes ?? [],
  };
}

function jsonlRecords(records: readonly SubjectExportRecord[]): Buffer {
  if (records.length > MAX_ASSEMBLY_RECORDS)
    throw new Error("privacy archive has too many records");
  const lines: Buffer[] = [];
  let bytes = 0;
  for (const record of [...records].sort((left, right) => left.id.localeCompare(right.id))) {
    const line = Buffer.from(`${JSON.stringify(articleRecord(record))}\n`, "utf8");
    bytes += line.byteLength;
    if (bytes > MAX_ASSEMBLY_MEMBER_BYTES) throw new Error("privacy archive member exceeds bound");
    lines.push(line);
  }
  return Buffer.concat(lines, bytes);
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
export function renderReadmeHtml(localeInput: string): string {
  const locale = resolveLocale(localeInput);
  const t = createTranslator(locale, "privacyExport.readme");
  const title = t("title");
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem}code{background:#eee;padding:.1rem .25rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(t("description"))}</p><p>${escapeHtml(t("credentials"))}</p></body></html>`;
}
function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
type ArchiveWriteEntrySource = ArchiveEntryInput["source"];

const ARCHIVE_SCHEMAS: ReadonlyArray<{
  logicalId: string;
  schemaId: string;
  schema: Record<string, unknown>;
}> = [
  {
    logicalId: "manifest-schema",
    schemaId: "export-manifest-v2",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/export-manifest-v2",
      type: "object",
      required: [
        "version",
        "generatedAt",
        "expiresAt",
        "root",
        "locale",
        "request",
        "controller",
        "deployment",
        "timing",
        "collectorOutcomes",
        "reviewContact",
        "translationFallbacks",
        "members",
      ],
      properties: {
        version: { const: 2 },
        generatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        root: { const: "openmapx-data-export/" },
        locale: { enum: locales },
        request: {
          type: "object",
          required: ["id", "kind", "rights"],
          properties: {
            id: { type: "string" },
            kind: { enum: ["access", "portability", "access_and_portability"] },
            rights: {
              type: "object",
              required: ["access", "portability"],
              properties: { access: { type: "boolean" }, portability: { type: "boolean" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        controller: { type: "object" },
        deployment: { type: "object" },
        timing: { type: "object" },
        collectorOutcomes: { type: "array", items: { type: "object" } },
        reviewContact: { type: "string" },
        translationFallbacks: { type: "array", items: { type: "object" } },
        members: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "logicalId", "mediaType", "bytes", "sha256"],
            properties: {
              path: { type: "string" },
              logicalId: { type: "string" },
              mediaType: { type: "string" },
              bytes: { type: "integer", minimum: 0 },
              sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              records: { type: ["integer", "null"], minimum: 0 },
              schema: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    logicalId: "category-schema",
    schemaId: "category-manifest-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/category-manifest-v1",
      type: "object",
      required: ["id", "version", "outcome"],
      properties: {
        id: { type: "string" },
        version: { type: "string" },
        outcome: {
          enum: [
            "included",
            "not_applicable",
            "unavailable",
            "reviewed_no_match",
            "omitted_with_reason",
          ],
        },
      },
      additionalProperties: true,
    },
  },
  {
    logicalId: "export-record-schema",
    schemaId: "article-15-record-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/article-15-record-v1",
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[a-f0-9]{64}$" },
        policyCodes: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
  },
  {
    logicalId: "backup-record-schema",
    schemaId: "backup-history-record-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/backup-history-record-v1",
      type: "object",
      additionalProperties: true,
    },
  },
  {
    logicalId: "backup-source-schema",
    schemaId: "backup-source-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/backup-source-v1",
      type: "object",
      required: ["version"],
      properties: { version: { const: 1 } },
      additionalProperties: true,
    },
  },
  {
    logicalId: "portable-profile-schema",
    schemaId: "article-20-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/portable-profile-v1",
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: true,
      },
    },
  },
  {
    logicalId: "portable-places-schema",
    schemaId: "article-20-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/portable-places-v1",
      type: "object",
      required: ["type", "features"],
      properties: {
        type: { const: "FeatureCollection" },
        features: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "geometry", "properties"],
            properties: {
              type: { const: "Feature" },
              geometry: { type: "object", required: ["type", "coordinates"] },
              properties: { type: "object" },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    logicalId: "processing-information-schema",
    schemaId: "processing-information-v2",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://openmapx.example/privacy/processing-information-v2",
      type: "object",
      required: [
        "version",
        "request",
        "controller",
        "deployment",
        "generatedAt",
        "expiresAt",
        "reviewContact",
        "recipientSummary",
        "translationFallbacks",
        "sources",
      ],
      properties: {
        version: { const: 2 },
        request: { type: "object" },
        controller: { type: "object" },
        deployment: { type: "object" },
        generatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        reviewContact: { type: "string" },
        recipientSummary: { type: ["object", "null"] },
        translationFallbacks: { type: "array", items: { type: "object" } },
        sources: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "version", "category", "outcome", "recordCount", "warningCodes"],
            properties: {
              id: { type: "string" },
              version: { type: "integer", minimum: 1 },
              category: { type: "string" },
              outcome: { type: "string" },
              recordCount: { type: "integer", minimum: 0 },
              warningCodes: { type: "array", items: { type: "string" } },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: false,
    },
  },
];

const CATEGORY_TARGETS: Record<
  string,
  | "account"
  | "authentication"
  | "saved-content"
  | "vehicles"
  | "sharing"
  | "timeline-connections"
  | "activity"
  | "disclosures"
  | "requests"
  | "other"
> = {
  "account-profile": "account",
  "auth-accounts": "authentication",
  "auth-sessions": "authentication",
  "auth-passkeys": "authentication",
  "auth-two-factor": "authentication",
  "auth-verifications": "authentication",
  "auth-oauth-resources": "authentication",
  "mobile-auth-handoffs": "authentication",
  "saved-lists": "saved-content",
  "saved-places": "saved-content",
  "labeled-places": "saved-content",
  "personal-vehicles": "vehicles",
  "parked-locations": "vehicles",
  "share-links": "sharing",
  "timeline-connections": "timeline-connections",
  "admin-audit-attribution": "activity",
  "disclosure-events": "disclosures",
  "privacy-case-records": "requests",
};

const PORTABLE_TARGETS: Record<
  string,
  | "profile"
  | "portable-lists"
  | "portable-places"
  | "portable-vehicles"
  | "portable-parking"
  | "preferences"
> = {
  "account-profile": "profile",
  "saved-lists": "portable-lists",
  "saved-places": "portable-places",
  "labeled-places": "portable-places",
  "personal-vehicles": "portable-vehicles",
  "parked-locations": "portable-parking",
};

function geoJson(records: readonly SubjectExportRecord[]): Record<string, unknown> {
  if (records.length > MAX_ASSEMBLY_RECORDS)
    throw new Error("privacy archive has too many records");
  return {
    type: "FeatureCollection",
    features: records.flatMap((record) => {
      const coordinates = record.data.coordinates;
      return Array.isArray(coordinates) && coordinates.length === 2
        ? [
            {
              type: "Feature",
              id: record.id,
              geometry: { type: "Point", coordinates },
              properties: Object.fromEntries(
                Object.entries(record.data).filter(([key]) => key !== "coordinates"),
              ),
            },
          ]
        : [];
    }),
  };
}

export interface SubjectArchiveAssemblyInput {
  requestId: string;
  artifactId: string;
  locale: Locale;
  parts: readonly CollectorSourcePart[];
  sourceEntries?: readonly CollectorSourcePartEntry[];
  disposeSources?: () => void | Promise<void>;
  writer: PrivacyArchiveWriter;
  generatedAt?: string;
  responseContext: PrivacyResponseContext;
}

function includesAccess(kind: PrivacyResponseContext["request"]["kind"]): boolean {
  return kind === "access" || kind === "access_and_portability";
}

function includesPortability(kind: PrivacyResponseContext["request"]["kind"]): boolean {
  return kind === "portability" || kind === "access_and_portability";
}

function requestedSchema(
  logicalId: string,
  kind: PrivacyResponseContext["request"]["kind"],
): boolean {
  if (["portable-profile-schema", "portable-places-schema"].includes(logicalId))
    return includesPortability(kind);
  if (
    [
      "category-schema",
      "export-record-schema",
      "processing-information-schema",
      "backup-record-schema",
      "backup-source-schema",
    ].includes(logicalId)
  )
    return includesAccess(kind);
  return true;
}

function requestedSourceEntry(
  logicalId: string,
  kind: PrivacyResponseContext["request"]["kind"],
): boolean {
  const path = archivePathForLogicalId(logicalId);
  if (!path) return true;
  if (path.includes("/article-15/")) return includesAccess(kind);
  if (path.includes("/portable/")) return includesPortability(kind);
  return true;
}

async function assembleSubjectArchiveInternal(
  input: SubjectArchiveAssemblyInput,
): Promise<ArchiveWriteResult & { entryPaths: string[] }> {
  const byRegistration = new Map(input.parts.map((part) => [part.registrationId, part]));
  const entries: {
    logicalId: string;
    source: ArchiveWriteEntrySource;
    mediaType: string;
    bytes?: number;
    sha256?: string;
    recordCount?: number;
    schemaId?: string;
  }[] = [];
  const kind = input.responseContext.request.kind;
  if (input.responseContext.request.id !== input.requestId)
    throw new Error("Privacy response request context mismatch");

  // Schemas are static, committed contract members.  They are included in
  // every archive so a recipient can validate the payload without consulting
  // the running service.
  for (const schema of ARCHIVE_SCHEMAS) {
    if (!requestedSchema(schema.logicalId, kind)) continue;
    entries.push({
      logicalId: schema.logicalId,
      source: json(schema.schema),
      mediaType: "application/schema+json",
      schemaId: schema.schemaId,
    });
  }

  const articleParts = new Map<string, SubjectExportRecord[]>();
  const portableParts = new Map<string, SubjectExportRecord[]>();
  let assembledRecords = 0;
  for (const registration of SUBJECT_DATA_CATALOGUE) {
    const part = byRegistration.get(registration.id);
    if (!part || part.outcome === "not_applicable") continue;
    const records = part.records;
    assembledRecords += records.length;
    if (assembledRecords > MAX_ASSEMBLY_RECORDS)
      throw new Error("privacy archive has too many records");
    if (includesAccess(kind)) {
      const articleTarget = CATEGORY_TARGETS[registration.id] ?? "other";
      const articleRecords = articleParts.get(articleTarget) ?? [];
      articleRecords.push(
        ...records.map((record) => ({
          ...record,
          data: { ...record.data, registrationId: registration.id },
        })),
      );
      articleParts.set(articleTarget, articleRecords);
    }
    const portableTarget = PORTABLE_TARGETS[registration.id];
    if (portableTarget && includesPortability(kind)) {
      const portableRecords = portableParts.get(portableTarget) ?? [];
      portableRecords.push(...records.filter((record) => record.portable));
      portableParts.set(portableTarget, portableRecords);
    }
  }
  const articleLogical: Record<string, string> = {
    account: "account",
    authentication: "authentication",
    "saved-content": "saved-content",
    vehicles: "vehicles",
    sharing: "sharing",
    "timeline-connections": "timeline-connections",
    activity: "activity",
    disclosures: "disclosures",
    requests: "requests",
    other: "other",
  };
  for (const [target, records] of articleParts) {
    if (!records.length) continue;
    const bytes =
      target === "account" || target === "authentication"
        ? json(records.map(articleRecord))
        : jsonlRecords(records);
    const logicalId = articleLogical[target];
    entries.push({
      logicalId,
      source: bytes,
      mediaType:
        target === "account" || target === "authentication"
          ? "application/json"
          : "application/jsonl",
      recordCount: records.length,
      schemaId: "article-15-record-v1",
    });
  }
  for (const [target, records] of portableParts) {
    if (!records.length) continue;
    let bytes: Buffer;
    if (target === "portable-places" || target === "portable-parking")
      bytes = json(geoJson(records));
    else bytes = json(records.map((record) => ({ id: record.id, ...record.data })));
    entries.push({
      logicalId: target,
      source: bytes,
      mediaType:
        target.includes("places") || target.includes("parking")
          ? "application/geo+json"
          : "application/json",
      recordCount: records.length,
      schemaId: "article-20-v1",
    });
  }

  // Managed sources may provide fixed, already validated entries.  The
  // archive writer maps their logical IDs to paths; no collector can inject a
  // path or filename.  Source parts stay streams where possible.
  for (const sourceEntries of [
    input.sourceEntries ?? [],
    ...input.parts.map((part) => part.entries ?? []),
  ]) {
    for (const entry of sourceEntries) {
      if (!requestedSourceEntry(entry.logicalId, kind)) continue;
      if (entries.some((existing) => existing.logicalId === entry.logicalId))
        throw new Error(`duplicate source logical ID: ${entry.logicalId}`);
      entries.push({
        logicalId: entry.logicalId,
        source: Buffer.isBuffer(entry.source)
          ? entry.source
          : entry.source instanceof Uint8Array
            ? Buffer.from(entry.source)
            : entry.source,
        mediaType: entry.mediaType,
        bytes: entry.bytes,
        sha256: entry.sha256,
        recordCount: entry.recordCount,
        schemaId: entry.schemaId,
      });
    }
  }
  const report = buildPrivacyResponseReport({
    locale: input.locale,
    context: input.responseContext,
    sources: input.parts.map((part) => ({
      registrationId: part.registrationId,
      category: part.category,
      outcome: part.outcome,
      warningCodes: part.warningCodes,
      capturedAt: part.capturedAt,
      recordCount: part.recordCount ?? part.records.length,
    })),
  });
  entries.unshift(
    { logicalId: "readme-html", source: Buffer.from(report.html), mediaType: "text/html" },
    { logicalId: "readme-text", source: Buffer.from(report.text), mediaType: "text/plain" },
  );
  if (includesAccess(kind))
    entries.push({
      logicalId: "processing-information",
      source: json(report.processingInformation),
      mediaType: "application/json",
      schemaId: "processing-information-v2",
    });
  // The manifest hashes every other plaintext member, never itself.
  const generatedAt = input.responseContext.generatedAt;
  if (input.generatedAt !== undefined && input.generatedAt !== generatedAt)
    throw new Error("Privacy response generation timestamp mismatch");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt))
    throw new Error("Invalid archive generation timestamp");
  const members = entries.map((entry) => {
    const bytes =
      entry.bytes ?? (Buffer.isBuffer(entry.source) ? entry.source.byteLength : undefined);
    const sha256 =
      entry.sha256 ?? (Buffer.isBuffer(entry.source) ? digest(entry.source) : undefined);
    if (bytes === undefined || sha256 === undefined)
      throw new Error(`Missing archive facts for ${entry.logicalId}`);
    return {
      path: archivePathForLogicalId(entry.logicalId),
      logicalId: entry.logicalId,
      mediaType: entry.mediaType,
      bytes,
      sha256,
      records: entry.recordCount ?? null,
      schema: entry.schemaId ?? null,
    };
  });
  if (members.some((member) => member.path === null))
    throw new Error("Missing archive path for registered member");
  const manifest = {
    version: 2,
    generatedAt,
    expiresAt: input.responseContext.expiresAt,
    root: "openmapx-data-export/",
    locale: input.locale,
    request: {
      id: input.responseContext.request.id,
      kind,
      rights: {
        access: includesAccess(kind),
        portability: includesPortability(kind),
      },
    },
    controller: input.responseContext.controller,
    deployment: input.responseContext.deployment,
    timing: {
      receivedAt: input.responseContext.request.receivedAt,
      registeredAt: input.responseContext.request.registeredAt,
      preservationAt: input.responseContext.request.preservationAt,
      snapshotAt: input.responseContext.request.snapshotAt,
      generatedAt,
      expiresAt: input.responseContext.expiresAt,
    },
    collectorOutcomes: report.processingInformation.sources.map((source) => ({
      registrationId: source.id,
      outcome: source.outcome,
      recordCount: source.recordCount,
      capturedAt: source.capturedAt,
      warningCodes: source.warningCodes,
    })),
    reviewContact: input.responseContext.reviewContact,
    translationFallbacks: report.translationFallbacks,
    members,
  };
  const manifestBuffer = json(manifest);
  entries.push({
    logicalId: "manifest",
    source: manifestBuffer,
    mediaType: "application/json",
    bytes: manifestBuffer.byteLength,
    sha256: digest(manifestBuffer),
    schemaId: "export-manifest-v2",
  });
  const archive = await input.writer.writeArchive({
    requestId: input.requestId,
    artifactId: input.artifactId,
    entries,
  });
  return { ...archive, entryPaths: archive.entries.map((entry) => entry.path) };
}

export async function assembleSubjectArchive(
  input: SubjectArchiveAssemblyInput,
): Promise<ArchiveWriteResult & { entryPaths: string[] }> {
  try {
    return await assembleSubjectArchiveInternal(input);
  } finally {
    await Promise.allSettled([
      ...input.parts.map((part) => part.disposeSources?.()),
      input.disposeSources?.(),
    ]);
  }
}
