import {
  COVERAGE_DOMAINS,
  type CoverageDomain,
  type UsageAssessment,
} from "@openmapx/core/coverage";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  CoverageCollectionUnavailableError,
  type CoverageCollectorOptions,
} from "../services/coverage/collect.js";
import {
  CoverageHttpError,
  type CoverageRegionsQuery,
  type CoverageReportQuery,
  type CoverageService,
  type CoverageSourceQuery,
  createCoverageService,
} from "../services/coverage/service.js";
import { requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";

const MAX_REGION_ID = 256;
const MAX_SOURCE_KEY = 512;
const MAX_SNAPSHOT_ID = 128;
const MAX_SEARCH = 256;
const MAX_OFFSET = 10_000_000;
const MAX_LIMIT = 100;

const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ASSESSMENTS = [
  "operational",
  "commercial",
  "redistribute-source-data",
  "redistribute-derived-data",
] as const;

type QueryValue = string | string[] | undefined;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

interface CoverageQuerystring {
  regionId?: string;
  snapshotId?: string;
  domain?: string;
  attention?: string;
  enabled?: string;
  assessment?: string;
  search?: string;
  key?: string;
  offset?: string;
  limit?: string;
}

export interface AdminCoverageRouteOptions extends Partial<CoverageCollectorOptions> {
  coverageService?: CoverageService;
}

function queryValue(value: QueryValue, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CoverageHttpError(400, `${name}_invalid`);
  return value;
}

function boundedText(
  value: QueryValue,
  name: string,
  max: number,
  options: { opaque?: boolean; required?: boolean } = {},
): string | undefined {
  const parsed = queryValue(value, name);
  if (parsed === undefined || parsed === "") {
    if (options.required) throw new CoverageHttpError(400, `${name}_required`);
    return undefined;
  }
  if (parsed.length > max || hasControlCharacters(parsed)) {
    throw new CoverageHttpError(400, `${name}_invalid`);
  }
  if (options.opaque && (!OPAQUE_KEY_PATTERN.test(parsed) || parsed.includes(".."))) {
    throw new CoverageHttpError(400, `${name}_invalid`);
  }
  return parsed;
}

function enumValue<T extends string>(
  value: QueryValue,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const parsed = queryValue(value, name);
  if (parsed === undefined || parsed === "") return undefined;
  if (!allowed.includes(parsed as T)) throw new CoverageHttpError(400, `${name}_invalid`);
  return parsed as T;
}

function booleanValue(value: QueryValue, name: string): boolean | undefined {
  const parsed = queryValue(value, name);
  if (parsed === undefined || parsed === "") return undefined;
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new CoverageHttpError(400, `${name}_invalid`);
}

function nonNegativeInteger(value: QueryValue, name: string, max: number): number | undefined {
  const parsed = queryValue(value, name);
  if (parsed === undefined || parsed === "") return undefined;
  if (!/^\d+$/.test(parsed)) throw new CoverageHttpError(400, `${name}_invalid`);
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number > max) {
    throw new CoverageHttpError(400, `${name}_invalid`);
  }
  return number;
}

function applyNoStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
}

function sendCoverageError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CoverageHttpError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  if (error instanceof CoverageCollectionUnavailableError) {
    return reply.code(503).send({ error: "coverage_unavailable" });
  }
  return reply.code(503).send({ error: "coverage_unavailable" });
}

function parseRegionsQuery(query: CoverageQuerystring): CoverageRegionsQuery {
  return {
    snapshotId: boundedText(query.snapshotId, "snapshotId", MAX_SNAPSHOT_ID, { opaque: true }),
    search: boundedText(query.search, "search", MAX_SEARCH),
    offset: nonNegativeInteger(query.offset, "offset", MAX_OFFSET),
    limit: nonNegativeInteger(query.limit, "limit", MAX_LIMIT),
  };
}

function parseReportQuery(query: CoverageQuerystring): CoverageReportQuery {
  const regionId = boundedText(query.regionId, "regionId", MAX_REGION_ID, {
    opaque: true,
    required: true,
  });
  if (!regionId) throw new CoverageHttpError(400, "regionId_required");
  const enabled = enumValue(query.enabled, "enabled", ["all", "true", "false"] as const);
  return {
    regionId,
    snapshotId: boundedText(query.snapshotId, "snapshotId", MAX_SNAPSHOT_ID, { opaque: true }),
    domain: enumValue(query.domain, "domain", COVERAGE_DOMAINS),
    attention: booleanValue(query.attention, "attention"),
    enabled: enabled === undefined || enabled === "all" ? undefined : enabled === "true",
    assessment: enumValue(query.assessment, "assessment", ASSESSMENTS),
    offset: nonNegativeInteger(query.offset, "offset", MAX_OFFSET),
    limit: nonNegativeInteger(query.limit, "limit", MAX_LIMIT),
  };
}

function parseSourceQuery(query: CoverageQuerystring): CoverageSourceQuery {
  const key = boundedText(query.key, "key", MAX_SOURCE_KEY, { opaque: true, required: true });
  const regionId = boundedText(query.regionId, "regionId", MAX_REGION_ID, {
    opaque: true,
    required: true,
  });
  if (!key || !regionId) throw new CoverageHttpError(400, "source_query_required");
  return {
    key,
    regionId,
    snapshotId: boundedText(query.snapshotId, "snapshotId", MAX_SNAPSHOT_ID, { opaque: true }),
    assessment: enumValue(query.assessment, "assessment", ASSESSMENTS),
  };
}

function querySchema(properties: Record<string, Record<string, unknown>>, required: string[] = []) {
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

const commonQueryProperties = {
  snapshotId: {
    type: "string",
    minLength: 1,
    maxLength: MAX_SNAPSHOT_ID,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  },
  offset: { type: "string", pattern: "^[0-9]+$", maxLength: 8 },
  limit: { type: "string", pattern: "^[0-9]+$", maxLength: 3 },
};

export const adminCoverageRoute: FastifyPluginAsync<AdminCoverageRouteOptions> = async (
  app,
  options,
) => {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  const service = options.coverageService ?? createCoverageService(options);

  app.get<{ Querystring: CoverageQuerystring }>(
    "/admin/coverage/regions",
    {
      schema: {
        querystring: querySchema({
          ...commonQueryProperties,
          search: { type: "string", minLength: 1, maxLength: MAX_SEARCH },
        }),
      },
    },
    async (request, reply) => {
      applyNoStore(reply);
      try {
        return await service.regions(parseRegionsQuery(request.query));
      } catch (error) {
        return sendCoverageError(reply, error);
      }
    },
  );

  app.get<{ Querystring: CoverageQuerystring }>(
    "/admin/coverage",
    {
      schema: {
        querystring: querySchema(
          {
            ...commonQueryProperties,
            regionId: { type: "string", minLength: 1, maxLength: MAX_REGION_ID },
            domain: { type: "string", enum: [...COVERAGE_DOMAINS] },
            attention: { type: "string", enum: ["true", "false"] },
            enabled: { type: "string", enum: ["all", "true", "false"] },
            assessment: { type: "string", enum: [...ASSESSMENTS] },
          },
          ["regionId"],
        ),
      },
    },
    async (request, reply) => {
      applyNoStore(reply);
      try {
        return await service.report(parseReportQuery(request.query));
      } catch (error) {
        return sendCoverageError(reply, error);
      }
    },
  );

  app.get<{ Querystring: CoverageQuerystring }>(
    "/admin/coverage/source",
    {
      schema: {
        querystring: querySchema(
          {
            key: { type: "string", minLength: 1, maxLength: MAX_SOURCE_KEY },
            regionId: { type: "string", minLength: 1, maxLength: MAX_REGION_ID },
            snapshotId: commonQueryProperties.snapshotId,
            assessment: { type: "string", enum: [...ASSESSMENTS] },
          },
          ["key", "regionId"],
        ),
      },
    },
    async (request, reply) => {
      applyNoStore(reply);
      try {
        return await service.source(parseSourceQuery(request.query));
      } catch (error) {
        return sendCoverageError(reply, error);
      }
    },
  );
};

export type { CoverageDomain, UsageAssessment };
