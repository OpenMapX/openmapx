import type { IntegrationContext } from "@openmapx/core";

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/tiles/:z/:x/:y.png", async (req, reply) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (![z, x, y].every((v) => Number.isFinite(v) && v >= 0)) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }

    const baseUrl =
      process.env.OPENSNOWMAP_TILE_URL ?? "https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png";
    const url = baseUrl
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        reply.status(response.status).send({ message: "Upstream tile fetch failed" });
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.type("image/png");
      reply.send(buffer);
    } catch (err) {
      ctx.log.warn("Winter sports tile fetch failed", err);
      reply.status(502).send({ message: "Winter sports tile provider unavailable" });
    }
  });
}
