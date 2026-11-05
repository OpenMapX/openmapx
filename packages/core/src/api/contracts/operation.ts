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
  auth: "public" | "session" | "service" | "admin" | "privacy_admin";
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
  if (typeof key !== "string" || !Object.hasOwn(selector.values, key)) return [];
  return [selector.values[key]];
}
