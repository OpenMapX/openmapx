import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { autocompleteRoute } from "./routes/autocomplete";
import { directionsRoute } from "./routes/directions";
import { geocodeRoute } from "./routes/geocode";
import { placesRoute } from "./routes/places";
import { trafficRoute } from "./routes/traffic";

const server = Fastify({ logger: true });

await server.register(helmet);
await server.register(cors, {
  origin: process.env.CORS_ORIGIN ?? "http://localhost:3001",
});

// Health check
server.get("/health", async () => ({ status: "ok" }));

// Routes
await server.register(geocodeRoute, { prefix: "/api" });
await server.register(autocompleteRoute, { prefix: "/api" });
await server.register(placesRoute, { prefix: "/api" });
await server.register(directionsRoute, { prefix: "/api" });
await server.register(trafficRoute, { prefix: "/api" });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
