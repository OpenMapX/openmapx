import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dereference, sanitize, validate } from "@scalar/openapi-parser";
import YAML from "yaml";

// `@hey-api/openapi-ts` is a build-time SDK generator that pulls in the full
// TypeScript compiler. Importing it eagerly inflates downstream bundles
// (apps/api ships dist/server.js via esbuild) and forces every transitive
// consumer of this package to keep `typescript` as a runtime dependency.
// `generateTompSdk` is the only caller, so load it lazily there.

const TOMP_HTTP_METHODS = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const;

export type TompHttpMethod = (typeof TOMP_HTTP_METHODS)[number];
type TompRecord = Record<string, unknown>;

export interface TompOpenApiInfo extends TompRecord {
  description?: string;
  title?: string;
  version?: string;
}

export interface TompOpenApiDocument extends TompRecord {
  components?: Record<string, TompRecord>;
  info?: TompOpenApiInfo;
  openapi?: string;
  paths?: Record<string, TompRecord>;
  security?: TompRecord[];
  servers?: TompRecord[];
  tags?: TompRecord[];
}

export interface TompNamedDocument {
  content?: string;
  document?: TompOpenApiDocument;
  fileName: string;
}

export interface TompOperationSummary {
  method: TompHttpMethod;
  modules: string[];
  operationId?: string;
  path: string;
  securitySchemeNames: string[];
  summary?: string;
  tags: string[];
}

export interface TompValidationResult {
  document: TompOpenApiDocument;
  errors: unknown[];
  valid: boolean;
}

export interface GenerateTompSdkOptions {
  document?: TompOpenApiDocument;
  documents?: TompNamedDocument[];
  openApiTsConfig?: Record<string, unknown>;
  outputPath: string;
  plugins?: Array<Record<string, unknown>>;
  validate?: boolean;
}

function isRecord(value: unknown): value is TompRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFileName(fileName: string): string {
  return basename(fileName);
}

function decodeJsonPointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function parseOpenApiVersion(value: string | undefined): number[] {
  return (value ?? "")
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .map((segment) => (Number.isFinite(segment) ? segment : 0));
}

function compareOpenApiVersion(a: string | undefined, b: string | undefined): number {
  const left = parseOpenApiVersion(a);
  const right = parseOpenApiVersion(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

function normalizeTompDocument(document: TompOpenApiDocument): TompOpenApiDocument {
  return sanitize(structuredClone(document) as never) as TompOpenApiDocument;
}

function formatTompValidationErrors(errors: unknown[]): string {
  return errors
    .map((error) => {
      if (!isRecord(error)) return JSON.stringify(error);
      if (typeof error.message === "string") return error.message;
      return JSON.stringify(error);
    })
    .join("; ");
}

function collectTompRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTompRefs(item, refs);
    return;
  }

  if (!isRecord(node)) return;
  if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) refs.add(node.$ref);
  for (const value of Object.values(node)) collectTompRefs(value, refs);
}

function cloneAndRewriteTompRefs(node: unknown, includedFiles: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => cloneAndRewriteTompRefs(item, includedFiles));
  if (!isRecord(node)) return node;

  const rewritten: TompRecord = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const [filePart, pointerPart = ""] = value.split("#");
      if (filePart && includedFiles.has(normalizeFileName(filePart))) {
        rewritten.$ref = `#${pointerPart}`;
        continue;
      }
    }
    rewritten[key] = cloneAndRewriteTompRefs(value, includedFiles);
  }
  return rewritten;
}

function mergeTompArrays(target: TompRecord, key: string, values: unknown[] | undefined): void {
  if (!values || values.length === 0) return;
  const existing = Array.isArray(target[key]) ? [...target[key]] : [];
  const seen = new Set(existing.map((value) => JSON.stringify(value)));

  for (const value of values) {
    const fingerprint = JSON.stringify(value);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    existing.push(value);
  }

  target[key] = existing;
}

function mergeTompTaggedArray(target: TompRecord, values: TompRecord[] | undefined): void {
  if (!values || values.length === 0) return;
  const existing = Array.isArray(target.tags) ? [...target.tags] : [];

  for (const value of values) {
    const name = typeof value.name === "string" ? value.name : null;
    if (!name) {
      existing.push(value);
      continue;
    }

    const index = existing.findIndex(
      (entry) => isRecord(entry) && typeof entry.name === "string" && entry.name === name,
    );

    if (index < 0) {
      existing.push(value);
      continue;
    }

    if (!isDeepStrictEqual(existing[index], value)) {
      throw new Error(`Conflicting TOMP tag definition for "${name}".`);
    }
  }

  target.tags = existing;
}

function mergeTompComponents(
  target: TompOpenApiDocument,
  components: Record<string, TompRecord> | undefined,
): void {
  if (!components) return;
  if (!target.components) target.components = {};

  for (const [groupName, groupValue] of Object.entries(components)) {
    if (!isRecord(groupValue)) continue;

    const existingGroup = target.components[groupName];
    if (existingGroup == null) {
      target.components[groupName] = structuredClone(groupValue);
      continue;
    }

    if (!isRecord(existingGroup)) {
      throw new Error(`Conflicting TOMP component group "${groupName}".`);
    }

    for (const [itemName, itemValue] of Object.entries(groupValue)) {
      const existingItem = existingGroup[itemName];
      if (existingItem == null) {
        existingGroup[itemName] = structuredClone(itemValue);
        continue;
      }

      if (!isDeepStrictEqual(existingItem, itemValue)) {
        throw new Error(`Conflicting TOMP component "${groupName}.${itemName}".`);
      }
    }
  }
}

function mergeTompPaths(
  target: TompOpenApiDocument,
  paths: Record<string, TompRecord> | undefined,
): void {
  if (!paths) return;
  if (!target.paths) target.paths = {};

  for (const [pathName, pathItem] of Object.entries(paths)) {
    const existingPath = target.paths[pathName];
    if (existingPath == null) {
      target.paths[pathName] = structuredClone(pathItem);
      continue;
    }

    if (!isRecord(existingPath)) {
      throw new Error(`Conflicting TOMP path "${pathName}".`);
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      const existingOperation = existingPath[method];
      if (existingOperation == null) {
        existingPath[method] = structuredClone(operation);
        continue;
      }

      if (!isDeepStrictEqual(existingOperation, operation)) {
        throw new Error(`Conflicting TOMP operation "${method.toUpperCase()} ${pathName}".`);
      }
    }
  }
}

function parseNamedTompDocument(input: TompNamedDocument): {
  document: TompOpenApiDocument;
  fileName: string;
} {
  if (input.document) {
    return {
      document: normalizeTompDocument(input.document),
      fileName: normalizeFileName(input.fileName),
    };
  }

  if (!input.content) {
    throw new Error(`Expected TOMP document content for "${input.fileName}".`);
  }

  return {
    document: parseTompOpenApiDocument(input.content),
    fileName: normalizeFileName(input.fileName),
  };
}

function requireTompRecord(document: unknown, message: string): TompOpenApiDocument {
  if (!isRecord(document)) throw new Error(message);
  return document as TompOpenApiDocument;
}

function resolveDocumentForSdk({
  document,
  documents,
}: Pick<GenerateTompSdkOptions, "document" | "documents">): TompOpenApiDocument {
  if (documents && documents.length > 0) return bundleTompOpenApiDocuments(documents);
  if (document) return normalizeTompDocument(document);
  throw new Error("Expected a bundled TOMP document or a list of named TOMP module files.");
}

export function parseTompOpenApiDocument(content: string): TompOpenApiDocument {
  const parsed = YAML.parse(content);
  return normalizeTompDocument(
    requireTompRecord(parsed, "Expected TOMP document to parse into an object."),
  );
}

export async function validateTompOpenApiDocument(
  input: TompOpenApiDocument | string,
): Promise<TompValidationResult> {
  const document =
    typeof input === "string" ? parseTompOpenApiDocument(input) : normalizeTompDocument(input);
  const result = await validate(document as never);
  return {
    document,
    errors: result.errors ?? [],
    valid: result.valid,
  };
}

export async function dereferenceTompOpenApiDocument(
  input: TompOpenApiDocument | string,
): Promise<TompOpenApiDocument> {
  const document =
    typeof input === "string" ? parseTompOpenApiDocument(input) : normalizeTompDocument(input);
  const result = await dereference(document as never);
  if (result.errors?.length) {
    throw new Error(
      `Failed to dereference TOMP OpenAPI document: ${formatTompValidationErrors(result.errors)}`,
    );
  }
  return requireTompRecord(
    result.schema,
    "Expected dereferenced TOMP OpenAPI document to resolve to an object.",
  );
}

export function listTompModules(document: TompOpenApiDocument): string[] {
  const modules = document.info?.["x-modules"];
  if (!Array.isArray(modules)) return [];
  return modules.filter((value): value is string => typeof value === "string");
}

export function listTompExternalRefs(document: TompOpenApiDocument): string[] {
  const refs = new Set<string>();
  collectTompRefs(document, refs);
  return [...refs].sort();
}

export function listTompOperations(document: TompOpenApiDocument): TompOperationSummary[] {
  const modules = listTompModules(document);
  const operations: TompOperationSummary[] = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!isRecord(pathItem)) continue;

    for (const method of TOMP_HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((value): value is string => typeof value === "string")
        : [];
      const securitySchemeNames = Array.isArray(operation.security)
        ? operation.security.flatMap((value) =>
            isRecord(value) ? Object.keys(value).filter((name) => typeof name === "string") : [],
          )
        : [];

      operations.push({
        method,
        modules,
        operationId: typeof operation.operationId === "string" ? operation.operationId : undefined,
        path,
        securitySchemeNames,
        summary: typeof operation.summary === "string" ? operation.summary : undefined,
        tags,
      });
    }
  }

  return operations;
}

export function resolveTompRef(
  ref: string,
  document: TompOpenApiDocument,
  documents: Record<string, TompOpenApiDocument> = {},
): unknown {
  const [filePart, pointer = ""] = ref.split("#");
  const targetDocument = filePart ? documents[normalizeFileName(filePart)] : document;
  if (!targetDocument) return undefined;
  if (pointer.length === 0) return targetDocument;

  const segments = pointer
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeJsonPointerToken);

  let current: unknown = targetDocument;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    if (!isRecord(current)) return undefined;
    current = current[segment];
  }

  return current;
}

export function bundleTompOpenApiDocuments(inputs: TompNamedDocument[]): TompOpenApiDocument {
  if (inputs.length === 0) throw new Error("Expected at least one TOMP document to bundle.");

  const parsedInputs = inputs.map(parseNamedTompDocument);
  const includedFiles = new Set(parsedInputs.map(({ fileName }) => fileName));
  const primaryDocument =
    parsedInputs.find(({ fileName }) => fileName.includes("CORE"))?.document ??
    parsedInputs[0].document;

  const bundled: TompOpenApiDocument = {
    info: structuredClone(primaryDocument.info ?? {}),
    openapi: primaryDocument.openapi,
  };

  const moduleNames = new Set(listTompModules(primaryDocument));

  for (const { document } of parsedInputs) {
    if (compareOpenApiVersion(document.openapi, bundled.openapi) > 0) {
      bundled.openapi = document.openapi;
    }

    for (const moduleName of listTompModules(document)) moduleNames.add(moduleName);
    mergeTompArrays(bundled, "servers", document.servers);
    mergeTompArrays(bundled, "security", document.security);
    mergeTompTaggedArray(bundled, document.tags?.filter(isRecord));
    mergeTompPaths(
      bundled,
      structuredClone(cloneAndRewriteTompRefs(document.paths, includedFiles)) as
        | Record<string, TompRecord>
        | undefined,
    );
    mergeTompComponents(
      bundled,
      structuredClone(cloneAndRewriteTompRefs(document.components, includedFiles)) as
        | Record<string, TompRecord>
        | undefined,
    );
  }

  if (!bundled.info) bundled.info = {};
  if (moduleNames.size > 0) bundled.info["x-modules"] = [...moduleNames].sort();

  return normalizeTompDocument(
    cloneAndRewriteTompRefs(bundled, includedFiles) as TompOpenApiDocument,
  );
}

export async function generateTompSdk(options: GenerateTompSdkOptions): Promise<string> {
  const document = resolveDocumentForSdk(options);
  if (options.validate !== false) {
    const result = await validateTompOpenApiDocument(document);
    if (!result.valid) {
      throw new Error(
        `Invalid TOMP OpenAPI document: ${formatTompValidationErrors(result.errors)}`,
      );
    }
  }

  await mkdir(options.outputPath, { recursive: true });

  const plugins = options.plugins ?? [
    { name: "@hey-api/typescript" },
    { name: "@hey-api/client-fetch" },
    { client: "@hey-api/client-fetch", name: "@hey-api/sdk" },
  ];

  const { createClient: generateOpenApiClient } = await import("@hey-api/openapi-ts");
  await generateOpenApiClient({
    input: document as never,
    output: options.outputPath,
    plugins,
    ...(options.openApiTsConfig ?? {}),
  } as never);

  return options.outputPath;
}
