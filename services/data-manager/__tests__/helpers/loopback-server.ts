import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Runs `work` against a real HTTP server on 127.0.0.1 that answers every
 * request with `handler`, so downloads go through the real `curl`. The server
 * is closed, with its connections, when `work` settles.
 */
export async function withLoopbackServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  work: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing loopback server");
    return await work(`http://127.0.0.1:${address.port}/fixture`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A handler that serves `body`, or 304 when the request is conditional and `notModified` is set. */
export function serve(body: string, { notModified = false } = {}) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (notModified && request.headers["if-modified-since"]) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  };
}
