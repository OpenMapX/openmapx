import { STATUS_CODES } from "node:http";
import { dataManagerAdminOperations } from "@openmapx/core/api-contracts";
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

type OperationId = keyof typeof dataManagerAdminOperations;
type ContractPart<
  K extends OperationId,
  P extends string,
> = (typeof dataManagerAdminOperations)[K] extends { request: infer R }
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
interface ResponseContract {
  kind: "json";
  schema: z.ZodType;
  headers?: z.ZodType;
}
interface RegistrationOptions {
  preHandler?: preHandlerHookHandler | preHandlerHookHandler[];
  beforeValidation?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** This feature registers actual API routes; authentication remains with their existing guards. */
export function registerDataManagerAdminRoute<K extends OperationId>(
  app: FastifyInstance,
  operationId: K,
  handler: (request: FastifyRequest<ContractRequest<K>>, reply: FastifyReply) => unknown,
  options: RegistrationOptions = {},
): void {
  const operation = dataManagerAdminOperations[operationId];
  const request = ("request" in operation ? operation.request : {}) as Record<string, z.ZodType>;
  const responses = operation.responses as Record<number, ResponseContract>;
  const convert = (validator: z.ZodType, identity: string, io: "input" | "output") =>
    routeJsonSchema(validator, {
      identity: `Admin_${identity}`,
      io,
      registerDefinition: (definition) => app.addSchema(definition),
    });
  const responseSchemas: Record<string, unknown> = {};
  for (const [status, contract] of Object.entries(responses)) {
    const body = convert(contract.schema, `${operationId}_${status}`, "output");
    const headers = contract.headers
      ? (convert(contract.headers, `${operationId}_${status}_headers`, "output") as {
          properties?: Record<string, unknown>;
        })
      : undefined;
    responseSchemas[status] = {
      description: "Response",
      content: { "application/json": { schema: body } },
      ...(headers ? { headers: headers.properties } : {}),
    };
  }
  const validate = (payload: unknown, status: number) => {
    const contract = responses[status];
    const result = contract?.schema.safeParse(payload);
    if (!result?.success) throw new Error("Invalid administration response");
    return result.data;
  };
  const requestSchemas = Object.fromEntries(
    Object.entries(request).map(([part, validator]) => [
      part === "query" ? "querystring" : part,
      convert(validator, `${operationId}_${part}`, part === "query" ? "output" : "input"),
    ]),
  );
  app.route<ContractRequest<K>>({
    method: operation.method,
    url: operation.path.slice("/api".length),
    config: { auth: operation.auth } as FastifyContextConfig & { auth: "admin" | "service" },
    schema: {
      operationId,
      tags: ["data-manager-admin"],
      ...requestSchemas,
      response: responseSchemas,
    },
    validatorCompiler: () => (value) => ({ value }),
    preHandler: options.preHandler,
    preValidation: async (req, reply) => {
      await options.beforeValidation?.(req as FastifyRequest, reply);
      if (reply.sent) return;
      for (const [part, validator] of Object.entries(request)) {
        const current = (req as unknown as Record<string, unknown>)[part];
        const parsed = validator.safeParse(current);
        if (!parsed.success)
          return reply.code(400).send({ error: `Invalid administration ${part}` });
        (req as unknown as Record<string, unknown>)[part] = parsed.data;
      }
    },
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
      const media = reply.getHeader("content-type")?.toString().split(";", 1)[0];
      if (
        media !== "application/json" ||
        (typeof payload !== "string" && !Buffer.isBuffer(payload))
      )
        throw new Error("Invalid administration response");
      validate(JSON.parse(payload.toString()), reply.statusCode);
      return payload;
    },
    handler: handler as (
      request: FastifyRequest<RouteGenericInterface>,
      reply: FastifyReply,
    ) => unknown,
  });
}
