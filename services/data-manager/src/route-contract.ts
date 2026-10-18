import { STATUS_CODES } from "node:http";
import { dataManagerOperations } from "@openmapx/core/data-manager-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import { z } from "zod/v4";

type OperationId = keyof typeof dataManagerOperations;
type ContractPart<
  K extends OperationId,
  P extends string,
> = (typeof dataManagerOperations)[K] extends { request: infer R }
  ? P extends keyof R
    ? R[P] extends z.ZodType
      ? z.output<R[P]>
      : unknown
    : unknown
  : unknown;
type ContractRequest<K extends OperationId> = {
  Body: ContractPart<K, "body">;
  Querystring: ContractPart<K, "query">;
  Params: ContractPart<K, "params">;
};
interface RuntimeSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false };
}
interface ResponseContract {
  kind: "json" | "ndjson" | "raw" | "empty";
  schema?: z.ZodType;
  contentTypes?: readonly string[];
  headers?: z.ZodType;
}

/** Schemas describe the JSON wire representation; custom refinements stay in Zod. */
function jsonSchema(
  app: FastifyInstance,
  identity: string,
  schema: z.ZodType,
  io: "input" | "output",
) {
  const {
    $schema: _dialect,
    definitions,
    $defs,
    ...source
  } = z.toJSONSchema(schema, { target: "draft-7", io });
  const localDefinitions = {
    ...(definitions && typeof definitions === "object" ? definitions : {}),
    ...$defs,
  };
  const identities = new Map(
    Object.keys(localDefinitions).map((name) => [name, `DataManager_${identity}_${name}`]),
  );
  function rewrite(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "$ref" && typeof child === "string") {
          const match = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(child);
          if (match) {
            const name = (match[1] ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
            const id = identities.get(name);
            if (!id) throw new Error(`Unresolved data-manager schema reference: ${identity}`);
            return [key, `${id}#`];
          }
        }
        return [key, rewrite(child)];
      }),
    );
  }
  const result = rewrite(source) as Record<string, unknown>;
  function omitUnrestrictedPropertyNames(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const names = node.propertyNames;
    if (
      names &&
      typeof names === "object" &&
      Object.keys(names).length === 1 &&
      (names as { type?: unknown }).type === "string"
    )
      delete node.propertyNames;
    for (const child of Object.values(node)) omitUnrestrictedPropertyNames(child);
  }
  omitUnrestrictedPropertyNames(result);
  for (const [name, definition] of Object.entries(localDefinitions)) {
    const resolved = rewrite(definition) as Record<string, unknown>;
    omitUnrestrictedPropertyNames(resolved);
    app.addSchema({ ...resolved, $id: identities.get(name) });
  }
  return result;
}

function invalidResponse(): Error {
  return new Error("Invalid data-manager response");
}

/** Register one actual route from its authoritative service contract. */
export function registerDataManagerRoute<K extends OperationId>(
  app: FastifyInstance,
  operationId: K,
  handler: (request: FastifyRequest<ContractRequest<K>>, reply: FastifyReply) => unknown,
): void {
  const operation = dataManagerOperations[operationId];
  const request = ("request" in operation ? operation.request : {}) as Record<string, z.ZodType>;
  const responses = operation.responses as Record<number, ResponseContract>;
  const schema: Record<string, unknown> = {
    operationId,
    tags: ["data-manager"],
    "x-openmapx-contract-id": operationId,
    "x-openmapx-auth": operation.auth,
    security: operation.auth === "service" ? [{ serviceBearer: [] }, { serviceToken: [] }] : [],
    response: {},
  };
  for (const [part, validator] of Object.entries(request)) {
    schema[part === "query" ? "querystring" : part] = jsonSchema(
      app,
      `${operationId}_request_${part}`,
      validator,
      "input",
    );
  }
  for (const [status, contract] of Object.entries(responses)) {
    const mediaTypes =
      contract.kind === "json"
        ? ["application/json"]
        : contract.kind === "ndjson"
          ? ["application/x-ndjson"]
          : (contract.contentTypes ?? []);
    (schema.response as Record<string, unknown>)[status] =
      contract.kind === "empty"
        ? { type: "null", description: "No response body" }
        : {
            description:
              contract.kind === "ndjson" ? "Progress, completion or error events" : "Response",
            content: Object.fromEntries(
              mediaTypes.map((mediaType) => [
                mediaType,
                {
                  schema: contract.schema
                    ? jsonSchema(
                        app,
                        `${operationId}_response_${status}`,
                        contract.schema,
                        "output",
                      )
                    : { type: "string", format: "binary" },
                },
              ]),
            ),
          };
  }
  for (const [status, contract] of Object.entries(responses)) {
    if (!contract.headers) continue;
    const metadata = jsonSchema(
      app,
      `${operationId}_response_${status}_headers`,
      contract.headers,
      "output",
    ) as { properties?: Record<string, unknown>; required?: string[] };
    const response = (schema.response as Record<string, Record<string, unknown>>)[status] ?? {};
    response.headers = Object.fromEntries(
      Object.entries(metadata.properties ?? {}).map(([name, header]) => [
        name,
        {
          ...(header as Record<string, unknown>),
          ...(metadata.required?.includes(name) ? { description: "Required response header" } : {}),
        },
      ]),
    );
  }
  const validateJson = (payload: unknown, status: number) => {
    const contract = responses[status];
    if (contract?.kind !== "json" || !contract.schema) throw invalidResponse();
    const parsed = contract.schema.safeParse(payload);
    if (!parsed.success) throw invalidResponse();
    return parsed.data;
  };
  app.route<ContractRequest<K>>({
    method: operation.method,
    url: operation.path,
    schema,
    // Fastify's default Ajv coercion/unknown-key removal must not change the
    // contract before Zod sees the actual request.
    validatorCompiler: () => (value) => ({ value }),
    preValidation: async (req, reply) => {
      for (const [part, validator] of Object.entries(request)) {
        const key = part === "query" ? "query" : part;
        const value = (req as unknown as Record<string, unknown>)[key];
        const parsed = (validator as RuntimeSchema).safeParse(value);
        if (!parsed.success) {
          const body =
            "requestErrors" in operation
              ? (operation.requestErrors as Record<string, unknown>)[part]
              : undefined;
          return reply.code(400).send(body ?? { error: `Invalid data-manager ${part}` });
        }
        (req as unknown as Record<string, unknown>)[key] =
          part === "headers" ? { ...req.headers, ...(parsed.data as object) } : parsed.data;
      }
    },
    // Fastify's native error fallback passes an Error-prototype envelope to
    // the serializer. Normalize its existing public fields rather than asking
    // strict JSON-schema union selection to inspect inherited implementation
    // fields. Every ordinary JSON value still validates before serialization.
    serializerCompiler:
      ({ httpStatus }) =>
      (payload) => {
        const status = Number(httpStatus);
        const contract = responses[status];
        if (contract?.kind === "empty") return "";
        if (contract?.kind !== "json") throw invalidResponse();
        let wire: unknown;
        if (payload instanceof Error) {
          const error = payload as Error & { error?: unknown; code?: unknown };
          wire = {
            statusCode: status,
            error:
              typeof error.error === "string" ? error.error : (STATUS_CODES[status] ?? "Error"),
            message: error.message,
            ...(error.code !== undefined ? { code: error.code } : {}),
          };
        } else {
          wire = JSON.parse(JSON.stringify(payload));
        }
        return JSON.stringify(validateJson(wire, status));
      },
    onSend: async (_req, reply, payload) => {
      const contract = responses[reply.statusCode];
      if (!contract) throw invalidResponse();
      validateDataManagerResponseHeaders(operationId, reply.statusCode, reply.getHeaders());
      if (contract.kind === "empty") return null;
      if (contract.kind !== "json") return payload;
      const mediaType = reply.getHeader("content-type")?.toString().split(";", 1)[0];
      if (mediaType !== "application/json") throw invalidResponse();
      // String and buffer replies can bypass serialization. Check the final
      // JSON body too, so those paths cannot bypass canonical validation.
      if (typeof payload !== "string" && !Buffer.isBuffer(payload)) throw invalidResponse();
      let body: unknown;
      try {
        body = JSON.parse(payload.toString());
      } catch {
        throw invalidResponse();
      }
      validateJson(body, reply.statusCode);
      return payload;
    },
    handler: handler as (
      request: FastifyRequest<RouteGenericInterface>,
      reply: FastifyReply,
    ) => unknown,
  });
}

/** Hijacked NDJSON bypasses Fastify's serializer and must validate each write. */
export function validateDataManagerEvent(operationId: OperationId, event: unknown): unknown {
  const contract = (
    dataManagerOperations[operationId].responses as Record<number, ResponseContract>
  )[200];
  if (contract?.kind !== "ndjson" || !contract.schema) throw invalidResponse();
  const parsed = contract.schema.safeParse(event);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

/** Validates normalized wire metadata, including hijacked stream headers. */
export function validateDataManagerResponseHeaders(
  operationId: OperationId,
  status: number,
  headers: Record<string, unknown>,
): void {
  const contract = (
    dataManagerOperations[operationId].responses as Record<number, ResponseContract>
  )[status];
  if (!contract) throw invalidResponse();
  if (!contract.headers) return;
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  if (!contract.headers.safeParse(normalized).success) throw invalidResponse();
}
