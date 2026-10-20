import { STATUS_CODES } from "node:http";
import type { AdminOperation, AdminResponseContract } from "@openmapx/core/api-contracts";
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

type Registry = Record<string, AdminOperation>;
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
export function createAdminRouteRegistrar<const R extends Registry>(
  registry: R,
  family: {
    tag: string;
    validationPhase: "preValidation" | "preHandler";
    documentOptionalBodies?: boolean;
  },
) {
  return function registerAdminRoute<K extends keyof R & string>(
    app: FastifyInstance,
    operationId: K,
    handler: (request: FastifyRequest<ContractRequest<R, K>>, reply: FastifyReply) => unknown,
    options: RegistrationOptions = {},
  ): void {
    const operation = registry[operationId];
    const request = ("request" in operation ? operation.request : {}) as Record<string, z.ZodType>;
    const responses = operation.responses as Record<number, AdminResponseContract>;
    const convert = (validator: z.ZodType, identity: string, io: "input" | "output") =>
      routeJsonSchema(validator, {
        identity: `Admin_${identity}`,
        io,
        registerDefinition: (definition) => app.addSchema(definition),
      });
    const responseSchemas: Record<string, unknown> = {};
    for (const [status, contract] of Object.entries(responses)) {
      const body =
        "schema" in contract
          ? convert(contract.schema, `${operationId}_${status}`, "output")
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
        ...(media ? { content: { [media]: { schema: body } } } : {}),
        ...(headers ? { headers: headers.properties } : {}),
      };
    }
    const validate = (payload: unknown, status: number) => {
      const contract = responses[status];
      const result =
        contract && "schema" in contract ? contract.schema.safeParse(payload) : undefined;
      if (!result?.success) throw new Error("Invalid administration response");
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
          return reply.code(400).send({ error: `Invalid administration ${part}` });
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
      } as FastifyContextConfig & { auth: "admin" | "service"; adminOptionalBody?: boolean },
      schema: {
        operationId,
        tags: [family.tag],
        ...requestSchemas,
        response: responseSchemas,
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
      onSend: async (_req, reply, payload) => {
        const contract = responses[reply.statusCode];
        if (!contract) throw new Error("Invalid administration response");
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
        if (contract.kind === "stream")
          throw new Error("Administration streams require a raw response");
        if (contract.kind === "empty") {
          if (payload !== "" && payload !== null && payload !== undefined)
            throw new Error("Invalid administration response");
          return payload;
        }
        const media = reply.getHeader("content-type")?.toString().split(";", 1)[0];
        if (
          media !== (contract.kind === "json" ? "application/json" : contract.mediaType) ||
          (typeof payload !== "string" && !Buffer.isBuffer(payload))
        )
          throw new Error("Invalid administration response");
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
