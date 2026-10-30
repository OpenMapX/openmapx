import { STATUS_CODES } from "node:http";
import type {} from "@fastify/swagger";
import {
  type ApiOperation,
  type ApiResponseContract,
  downloadMediaTypes,
} from "@openmapx/core/api-contracts";
import { routeJsonSchema } from "@openmapx/core/api-schema";
import type {
  FastifyContextConfig,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteGenericInterface,
} from "fastify";
import type z from "zod/v4";
import { bindAdminByteResponse, isAdminByteResponse } from "./admin-byte-response";

type Registry = Record<string, ApiOperation>;
type ContractPart<R extends Registry, K extends keyof R, P extends string> = R[K] extends {
  request: infer Request;
}
  ? P extends keyof Request
    ? Request[P] extends z.ZodType
      ? z.output<Request[P]>
      : unknown
    : unknown
  : unknown;
type ContractRequest<R extends Registry, K extends keyof R> = {
  Body: ContractPart<R, K, "body">;
  Querystring: ContractPart<R, K, "query">;
  Params: ContractPart<R, K, "params">;
};
export interface RegistrationOptions {
  preHandler?: preHandlerHookHandler | preHandlerHookHandler[];
  beforeValidation?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Shared registration; the family selects validation phase to preserve guard ordering. */
export function createContractRouteRegistrar<const R extends Registry>(
  registry: R,
  family: {
    tag: string;
    validationPhase: "preValidation" | "preHandler";
    documentOptionalBodies?: boolean;
    schemaPrefix?: string;
    label?: string;
    bodyLimit?: number;
    reuseSchemas?: boolean;
    validationErrorMessage?: (part: string, error: z.ZodError) => string;
  },
) {
  return function registerContractRoute<K extends keyof R & string>(
    app: FastifyInstance,
    operationId: K,
    handler: (request: FastifyRequest<ContractRequest<R, K>>, reply: FastifyReply) => unknown,
    options: RegistrationOptions = {},
  ): void {
    const operation = registry[operationId];
    const request = ("request" in operation ? operation.request : {}) as Record<string, z.ZodType>;
    const responses = operation.responses as Record<number, ApiResponseContract>;
    const convert = (validator: z.ZodType, identity: string, io: "input" | "output") =>
      routeJsonSchema(validator, {
        identity: `${family.schemaPrefix ?? "Admin"}_${identity}`,
        io,
        reused: family.reuseSchemas ? "ref" : undefined,
        registerDefinition: (definition) => app.addSchema(definition),
      });
    const responseSchemas: Record<string, unknown> = {};
    for (const [status, contract] of Object.entries(responses)) {
      const body =
        "schema" in contract
          ? convert(contract.schema, `${operationId}_${status}`, "output")
          : contract.kind === "bytes"
            ? { type: "string", format: "binary" }
            : { type: "string" };
      const media =
        contract.kind === "json"
          ? "application/json"
          : "mediaType" in contract
            ? contract.mediaType
            : undefined;
      const headers = contract.headers
        ? (convert(contract.headers, `${operationId}_${status}_headers`, "output") as {
            properties?: Record<string, unknown>;
          })
        : undefined;
      responseSchemas[status] = {
        description: "Response",
        ...(contract.kind === "text-download"
          ? {
              content: Object.fromEntries(
                contract.mediaTypes.map((type) => [
                  type,
                  { schema: { type: "string", format: "binary" } },
                ]),
              ),
            }
          : media
            ? { content: { [media]: { schema: body } } }
            : {}),
        ...(headers ? { headers: headers.properties } : {}),
      };
    }
    const validate = (payload: unknown, status: number) => {
      const contract = responses[status];
      const result =
        contract && "schema" in contract ? contract.schema.safeParse(payload) : undefined;
      if (!result?.success) throw new Error(`Invalid ${family.label ?? "administration"} response`);
      return result.data;
    };
    const requestSchema = (part: string, validator: z.ZodType) => {
      const schema = convert(
        validator,
        `${operationId}_${part}`,
        part === "query" || part === "headers" ? "output" : "input",
      ) as { required?: string[] };
      // Output schemas retain coercion bounds/defaults; input optionality is separate.
      if ((part === "query" || part === "headers") && "shape" in validator) {
        const shape = validator.shape as Record<string, z.ZodType>;
        if (schema.required)
          schema.required = schema.required.filter((key) => !shape[key]?.isOptional());
      }
      return schema;
    };
    const requestSchemas = Object.fromEntries(
      Object.entries(request).map(([part, validator]) => [
        part === "query" ? "querystring" : part,
        requestSchema(part, validator),
      ]),
    );
    const validateRequest = async (req: FastifyRequest, reply: FastifyReply) => {
      await options.beforeValidation?.(req as FastifyRequest, reply);
      if (reply.sent) return;
      for (const [part, validator] of Object.entries(request)) {
        const raw = (req as unknown as Record<string, unknown>)[part];
        // Fastify's schema validation normalizes an absent body to null. Keep
        // absence distinct from an explicit JSON null for optional mutations.
        const current =
          part === "body" && raw === null && !req.headers["content-type"] ? undefined : raw;
        const parsed = validator.safeParse(current);
        if (!parsed.success)
          return reply.code(400).send({
            error:
              family.validationErrorMessage?.(part, parsed.error) ??
              `Invalid ${family.label ?? "administration"} ${part}`,
          });
        (req as unknown as Record<string, unknown>)[part] =
          part === "headers" ? { ...req.headers, ...(parsed.data as object) } : parsed.data;
      }
    };
    app.route<ContractRequest<R, K>>({
      method: operation.method,
      url: operation.path.slice("/api".length),
      config: {
        auth: operation.auth,
        ...(family.documentOptionalBodies && request.body?.isOptional()
          ? { adminOptionalBody: true }
          : {}),
      } as FastifyContextConfig & { auth: ApiOperation["auth"]; adminOptionalBody?: boolean },
      schema: {
        operationId,
        ...(Object.values(responses).some((c) => c.kind === "bytes" && c.nativeDownload)
          ? { "x-openmapx-native-download": true }
          : {}),
        tags: [family.tag],
        ...requestSchemas,
        response: responseSchemas,
        ...(operation.requestBody
          ? {
              body: { type: "string", format: "binary" },
              consumes: [operation.requestBody.mediaType],
            }
          : {}),
      },
      ...(family.bodyLimit ? { bodyLimit: family.bodyLimit } : {}),
      onRequest: async (_request, reply) => {
        bindAdminByteResponse(reply, responses);
      },
      validatorCompiler: () => (value) => ({ value }),
      preValidation: family.validationPhase === "preValidation" ? validateRequest : undefined,
      preHandler:
        family.validationPhase === "preHandler"
          ? [validateRequest, ...[options.preHandler ?? []].flat()]
          : options.preHandler,
      // Fastify's error fallback supplies an Error-prototype envelope. Its
      // inherited fields do not satisfy strict anyOf serializer selection; emit
      // the same public envelope explicitly and validate its JSON wire value.
      serializerCompiler:
        ({ httpStatus }) =>
        (payload) => {
          const status = Number(httpStatus);
          if (responses[status]?.kind === "bytes")
            throw new Error(
              "Administration byte response must be streamed through its send adapter",
            );
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
          const contract = responses[status];
          if (contract?.kind === "text") return String(validate(payload, status));
          return JSON.stringify(validate(wire, status));
        },
      onSend: async (req, reply, payload) => {
        const contract = responses[reply.statusCode];
        if (!contract) throw new Error(`Invalid ${family.label ?? "administration"} response`);
        if (contract.headers) {
          const normalized = Object.fromEntries(
            Object.entries(reply.getHeaders())
              .filter(([, value]) => value !== undefined)
              .map(([name, value]) => [
                name.toLowerCase(),
                Array.isArray(value) ? value.join(", ") : String(value),
              ]),
          );
          if (!contract.headers.safeParse(normalized).success)
            throw new Error("Invalid administration response headers");
        }
        if (contract.kind === "bytes") {
          if (
            !isAdminByteResponse(reply) ||
            reply.getHeader("content-type")?.toString().split(";")[0] !== contract.mediaType
          )
            throw Error("Administration bytes require the canonical send adapter");
          return payload;
        }
        if (contract.kind === "text-download") {
          const media = reply
            .getHeader("content-type")
            ?.toString()
            .split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (
            !media ||
            !downloadMediaTypes(contract, req.query as Record<string, unknown>).includes(media) ||
            (typeof payload !== "string" && !Buffer.isBuffer(payload))
          )
            throw new Error("Invalid download response");
          return payload;
        }
        if (contract.kind === "stream")
          throw new Error("Administration streams require a raw response");
        if (contract.kind === "empty") {
          if (payload !== "" && payload !== null && payload !== undefined)
            throw new Error(`Invalid ${family.label ?? "administration"} response`);
          return payload;
        }
        const media = reply.getHeader("content-type")?.toString().split(";", 1)[0];
        if (
          media !== (contract.kind === "json" ? "application/json" : contract.mediaType) ||
          (typeof payload !== "string" && !Buffer.isBuffer(payload))
        )
          throw new Error(`Invalid ${family.label ?? "administration"} response`);
        validate(
          contract.kind === "json" ? JSON.parse(payload.toString()) : payload.toString(),
          reply.statusCode,
        );
        return payload;
      },
      handler: handler as (
        request: FastifyRequest<RouteGenericInterface>,
        reply: FastifyReply,
      ) => unknown,
    });
  };
}
