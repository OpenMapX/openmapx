import type z from "zod/v4";

/** Portable HTTP contract; auth metadata describes, never enforces access. */
export type ApiResponseContract =
  | { kind: "json"; schema: z.ZodType; headers?: z.ZodType }
  | { kind: "text"; schema: z.ZodType<string>; mediaType: string; headers?: z.ZodType }
  | { kind: "empty"; headers?: z.ZodType }
  | { kind: "bytes"; mediaType: string; headers?: z.ZodType; nativeDownload?: true }
  | { kind: "stream"; mediaType: string; headers?: z.ZodType }
  | {
      kind: "text-download";
      mediaTypes: readonly string[];
      headers?: z.ZodType;
      mediaTypeQuery?: { name: string; default: string; values: Readonly<Record<string, string>> };
    };
export interface ApiOperation {
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  path: `/api/${string}`;
  auth: "public" | "session" | "service" | "admin";
  request?: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType; headers?: z.ZodType };
  requestBody?: { kind: "bytes"; mediaType: "application/octet-stream" };
  responses: Record<number, ApiResponseContract>;
}

/** One declared request selector owns both server and client download media validation. */
export function downloadMediaTypes(
  contract: Extract<ApiResponseContract, { kind: "text-download" }>,
  query: Record<string, unknown>,
): readonly string[] {
  const selector = contract.mediaTypeQuery;
  if (!selector) return contract.mediaTypes;
  const key = query[selector.name] ?? selector.default;
  const mediaType = typeof key === "string" ? selector.values[key] : undefined;
  if (typeof key !== "string" || !Object.hasOwn(selector.values, key) || !mediaType) return [];
  return [mediaType];
}

/** Reject malformed first-party descriptors before registration or SDK acquisition. */
export function assertOperationContract(operation: ApiOperation): void {
  if (
    operation.requestBody &&
    (operation.request?.body ||
      operation.requestBody.kind !== "bytes" ||
      operation.requestBody.mediaType !== "application/octet-stream")
  )
    throw Error("Ambiguous binary request");
  for (const [status, contract] of Object.entries(operation.responses)) {
    if (
      "nativeDownload" in contract &&
      (contract.nativeDownload !== true ||
        contract.kind !== "bytes" ||
        operation.method !== "GET" ||
        Number(status) < 200 ||
        Number(status) >= 300)
    )
      throw Error("Native downloads require a successful GET byte response");
  }
}
