import type { FastifyInstance } from "fastify";

/** Real serialized Fastify responses enter the real ApiClient fetch boundary. */
export function administrationSdkFetch(
  app: FastifyInstance,
  options: { remoteAddress?: string } = {},
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (
      method !== "GET" &&
      method !== "POST" &&
      method !== "DELETE" &&
      method !== "PUT" &&
      method !== "PATCH"
    )
      throw new Error("Unexpected administration method");
    if (init?.body !== undefined && typeof init.body !== "string")
      throw new Error("Administration fixture expects a serialized JSON body");
    const result = await app.inject({
      method,
      remoteAddress: options.remoteAddress,
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: init?.body,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
    }
    return new Response(result.body, { status: result.statusCode, headers });
  };
}
