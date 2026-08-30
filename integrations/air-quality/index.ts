import type { AirQualityApiError } from "@openmapx/air-quality";
import {
  type IntegrationContext,
  QueryValidationError,
  type RouteHandler,
} from "@openmapx/integration-framework";

import { createCurrentService, NormalizedResponseTooLargeError } from "./current.js";
import { createForecastService } from "./forecast.js";
import { recordCanonicalError, recordPointMetric, recordStationsMetric } from "./metrics.js";
import { parsePointQuery, parseStationQuery } from "./query.js";
import { StationCursorExpiredError, StationCursorInvalidError } from "./station-snapshot.js";
import { createStationsService } from "./stations.js";

function sendError(
  reply: Parameters<RouteHandler>[1],
  status: number,
  code: AirQualityApiError["code"],
  message: string,
  details?: AirQualityApiError["details"],
): void {
  reply.status(status).send({ code, message, ...(details ? { details } : {}) });
}

function disabled(ctx: IntegrationContext, reply: Parameters<RouteHandler>[1]): boolean {
  if (ctx.config.enabled !== false) return false;
  sendError(reply, 503, "DOMAIN_DISABLED", "The canonical air-quality domain is disabled");
  return true;
}

function failure(reply: Parameters<RouteHandler>[1], error: unknown): void {
  if (error instanceof QueryValidationError) {
    sendError(reply, 400, "INVALID_QUERY", error.message, { parameter: error.key });
    return;
  }
  if (error instanceof StationCursorInvalidError) {
    sendError(reply, 400, "INVALID_QUERY", error.message);
    return;
  }
  if (error instanceof StationCursorExpiredError) {
    sendError(reply, 409, "CURSOR_EXPIRED", error.message);
    return;
  }
  if (error instanceof NormalizedResponseTooLargeError) {
    sendError(reply, 502, "NORMALIZED_RESPONSE_TOO_LARGE", error.message);
    return;
  }
  sendError(
    reply,
    502,
    "UPSTREAM_INVALID_RESPONSE",
    "Air-quality evidence could not be normalized safely",
  );
}

export function setup(ctx: IntegrationContext): void {
  const current = createCurrentService(ctx);
  const forecast = createForecastService(ctx);
  const stations = createStationsService(ctx);

  ctx.registerRoute(
    "GET",
    "/current",
    async (req, reply) => {
      const startedAt = Date.now();
      reply.header("Cache-Control", "private, max-age=0");
      if (disabled(ctx, reply)) return;
      try {
        const query = parsePointQuery(req.query, { forecast: false });
        const response = await current(query, req.signal);
        recordPointMetric(ctx, "current", response, startedAt);
        reply.send(response);
      } catch (error) {
        ctx.log.warn(
          `Canonical air-quality current request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        recordCanonicalError(ctx, "current", startedAt);
        failure(reply, error);
      }
    },
    { rateLimitTier: "expensive" },
  );

  ctx.registerRoute(
    "GET",
    "/forecast",
    async (req, reply) => {
      const startedAt = Date.now();
      reply.header("Cache-Control", "private, max-age=0");
      if (disabled(ctx, reply)) return;
      try {
        const query = parsePointQuery(req.query, { forecast: true });
        if (query.hours === undefined) throw new TypeError("Forecast horizon is missing");
        const response = await forecast({ ...query, hours: query.hours }, req.signal);
        recordPointMetric(ctx, "forecast", response, startedAt);
        reply.send(response);
      } catch (error) {
        ctx.log.warn(
          `Canonical air-quality forecast request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        recordCanonicalError(ctx, "forecast", startedAt);
        failure(reply, error);
      }
    },
    { rateLimitTier: "expensive" },
  );

  ctx.registerRoute(
    "GET",
    "/stations",
    async (req, reply) => {
      const startedAt = Date.now();
      reply.header("Cache-Control", "private, max-age=0");
      if (disabled(ctx, reply)) return;
      try {
        const response = await stations(parseStationQuery(req.query), req.signal);
        recordStationsMetric(ctx, response, startedAt);
        reply.send(response);
      } catch (error) {
        ctx.log.warn(
          `Canonical air-quality stations request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        recordCanonicalError(ctx, "stations", startedAt);
        failure(reply, error);
      }
    },
    { rateLimitTier: "expensive" },
  );
}
