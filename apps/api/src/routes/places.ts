import type { FastifyPluginAsync } from "fastify";
import { enrichPlace } from "../services/enrichment/index";
import { lookupByNameAndCoords, lookupByOsmRef } from "../services/nominatim-lookup.service";
import { buildReviewLinks } from "../services/review-links";

// Matches "node/12345", "way/678", "relation/99"
const OSM_ID_RE = /^(node|way|relation)\/(\d+)$/;

interface PlaceByIdQuery {
  lat?: string;
  lng?: string;
  name?: string;
}

export const placesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/places", async () => {
    return { data: [], message: "Not yet implemented — Phase 4 (nearby search)" };
  });

  fastify.get<{
    Params: { id: string };
    Querystring: PlaceByIdQuery;
  }>("/places/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      querystring: {
        type: "object",
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const rawId = decodeURIComponent(req.params.id);
      const match = OSM_ID_RE.exec(rawId);

      // OSM-native ID — direct Nominatim lookup, always accurate
      if (match) {
        const [, osmType, osmId] = match;
        const place = await lookupByOsmRef(osmType, osmId, rawId);
        const { externalIds, ...enrichment } = await enrichPlace(place);
        return { ...place, ...enrichment, reviewLinks: buildReviewLinks(place, externalIds) };
      }

      // Non-OSM ID (e.g. MapTiler) — search by name + coordinates.
      // Reverse-geocoding by coordinates alone is NOT used because it returns
      // whatever element is geometrically closest, which can be a completely
      // different place (e.g. a pitch instead of a school next to it).
      const lat = Number.parseFloat(req.query.lat ?? "");
      const lng = Number.parseFloat(req.query.lng ?? "");
      const name = req.query.name?.trim() ?? "";

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
        return reply.status(400).send({
          error: "Non-OSM place ID requires lat, lng, and name query parameters",
        });
      }

      const place = await lookupByNameAndCoords(name, lat, lng, rawId);
      if (!place) {
        return reply.status(404).send({
          error: `No OSM match found for "${name}" near [${lat}, ${lng}]`,
        });
      }
      const { externalIds, ...enrichment } = await enrichPlace(place);
      return { ...place, ...enrichment, reviewLinks: buildReviewLinks(place, externalIds) };
    },
  });
};
