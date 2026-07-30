import {
  FormData as UndiciFormData,
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
  fetch as undiciFetch,
} from "undici";

// Node 24 bundles undici 7.28.0, whose HTTP/1 parser throws an *uncatchable*
// AssertionError ("false == true" in Parser.finish / Socket.onHttpSocketEnd)
// that crashes the whole process when a socket ends while the parser is paused
// — e.g. a flaky upstream GBFS feed that closes the connection mid-body.
// See https://github.com/nodejs/undici/issues/5360 (fixed in undici 8.4.1+ via
// PR #5389 / #5474). The latest Node 24 LTS still ships the buggy 7.28.0, so we
// route every outbound fetch in this process through the fixed standalone
// undici 8.x instead. Keep the full Fetch API surface on the same implementation:
// standalone undici's `fetch` does not accept Node's bundled-undici `Request`
// objects. Mixing only the fetch function caused generated SDK clients to fail
// every request because they construct a global `Request` before dispatch.
//
// Server-only — this module is never bundled into the web app. The process-level
// onFatal guard in server.ts stays as defence-in-depth.
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
globalThis.FormData = UndiciFormData as unknown as typeof globalThis.FormData;
globalThis.Headers = UndiciHeaders as unknown as typeof globalThis.Headers;
globalThis.Request = UndiciRequest as unknown as typeof globalThis.Request;
globalThis.Response = UndiciResponse as unknown as typeof globalThis.Response;
