import {
  FormData as UndiciFormData,
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
  fetch as undiciFetch,
} from "undici";

// Node 24 bundles undici 7.28.0, whose HTTP/1 parser throws an *uncatchable*
// AssertionError ("false == true" in Parser.finish / Socket.onHttpSocketEnd)
// when an upstream closes a socket mid-body — which third-party POI/GTFS feeds
// do regularly. See https://github.com/nodejs/undici/issues/5360 (fixed in
// undici 8.4.1+). Because this process now treats every uncaught exception as
// fatal, route all outbound fetches through the fixed standalone undici 8.x,
// mirroring apps/api/src/undici-fetch.ts. Keep the whole Fetch surface on one
// implementation: standalone fetch rejects Node's bundled `Request` objects.
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
globalThis.FormData = UndiciFormData as unknown as typeof globalThis.FormData;
globalThis.Headers = UndiciHeaders as unknown as typeof globalThis.Headers;
globalThis.Request = UndiciRequest as unknown as typeof globalThis.Request;
globalThis.Response = UndiciResponse as unknown as typeof globalThis.Response;
