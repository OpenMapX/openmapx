import { fetch as undiciFetch } from "undici";

// Node 24 bundles undici 7.28.0, whose HTTP/1 parser throws an *uncatchable*
// AssertionError ("false == true" in Parser.finish / Socket.onHttpSocketEnd)
// that crashes the whole process when a socket ends while the parser is paused
// — e.g. a flaky upstream GBFS feed that closes the connection mid-body.
// See https://github.com/nodejs/undici/issues/5360 (fixed in undici 8.4.1+ via
// PR #5389 / #5474). The latest Node 24 LTS still ships the buggy 7.28.0, so we
// route every outbound fetch in this process through the fixed standalone
// undici 8.x instead. Server-only — this module is never bundled into the web
// app. `fetchJson` and friends call the global `fetch` dynamically, so swapping
// it before the server starts handling requests is sufficient. The
// process-level onFatal guard in server.ts stays as defence-in-depth.
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
