import type { FastifyPluginAsync } from "fastify";

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
        properties: { id: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const apiKey = process.env.TANKERKOENIG_API_KEY;
      if (!apiKey) {
        return reply.status(503).send({ error: "Fuel price provider not configured" });
      }

      // Strip the "tankerkoenig/" prefix if present
      const uuid = req.query.id.replace(/^tankerkoenig\//, "");

      const url = new URL(TANKERKOENIG_DETAIL_URL);
      url.searchParams.set("id", uuid);
      url.searchParams.set("apikey", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) {
        return reply.status(502).send({ error: `Tankerkoenig error: ${res.status}` });
      }

      const data = (await res.json()) as TankerkoenigDetailResponse;
      if (!data.ok || !data.station) {
        return reply.status(404).send({ error: data.message ?? "Station not found" });
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
    },
  });
};
