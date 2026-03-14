import type { FastifyPluginAsync } from "fastify";
import { withCache } from "../utils/cache.js";

const TANKERKOENIG_DETAIL_URL = "https://creativecommons.tankerkoenig.de/json/detail.php";

export interface OpeningTime {
  text: string;
  start: string;
  end: string;
}

interface TankerkoenigDetailStation {
  id: string;
  name: string;
  brand: string;
  openingTimes: OpeningTime[];
  overrides: string[];
  wholeDay: boolean;
  isOpen: boolean;
  e5: number | false | null;
  e10: number | false | null;
  diesel: number | false | null;
}

interface TankerkoenigDetailResponse {
  ok: boolean;
  station?: TankerkoenigDetailStation;
  message?: string;
}

export const fuelPricesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { id: string } }>("/fuel-prices/detail", {
    schema: {
      querystring: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", maxLength: 128 } },
      },
    },
    handler: async (req, reply) => {
      const apiKey = process.env.TANKERKOENIG_API_KEY;
      if (!apiKey) {
        return reply.status(503).send({ error: "Fuel price provider not configured" });
      }

      const uuid = req.query.id.replace(/^tankerkoenig\//, "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
        return reply.status(400).send({ error: "Invalid station ID format" });
      }
      const cacheKey = `cache:fuel:${uuid}`;

      // Cache-Control is set only on success — not on 404/502 error responses.
      try {
        const result = await withCache(cacheKey, 120, async () => {
          const url = new URL(TANKERKOENIG_DETAIL_URL);
          url.searchParams.set("id", uuid);
          url.searchParams.set("apikey", apiKey);

          const res = await fetch(url.toString());
          if (!res.ok) {
            throw Object.assign(new Error(`Tankerkoenig error: ${res.status}`), {
              statusCode: 502,
            });
          }

          const data = (await res.json()) as TankerkoenigDetailResponse;
          if (!data.ok || !data.station) {
            throw Object.assign(new Error(data.message ?? "Station not found"), {
              statusCode: 404,
            });
          }

          const s = data.station;
          return {
            id: `tankerkoenig/${s.id}`,
            isOpen: s.isOpen,
            wholeDay: s.wholeDay,
            openingTimes: s.openingTimes ?? [],
            overrides: s.overrides ?? [],
            fuelPrices: {
              e5: s.e5 != null && s.e5 !== false ? s.e5 : undefined,
              e10: s.e10 != null && s.e10 !== false ? s.e10 : undefined,
              diesel: s.diesel != null && s.diesel !== false ? s.diesel : undefined,
            },
          };
        });
        reply.header("Cache-Control", "public, max-age=120");
        return result;
      } catch (err) {
        const e = err as { statusCode?: number; message: string };
        return reply.status(e.statusCode ?? 500).send({ error: e.message });
      }
    },
  });
};
