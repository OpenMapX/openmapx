import {
  FormData as UndiciFormData,
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
  fetch as undiciFetch,
} from "undici";

// Node 24's bundled Undici can terminate the process when an upstream closes a
// socket while its HTTP/1 parser is paused. Keep fetch and the related classes
// on the fixed standalone implementation because Requests from the bundled and
// standalone implementations are not interchangeable.
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
globalThis.FormData = UndiciFormData as unknown as typeof globalThis.FormData;
globalThis.Headers = UndiciHeaders as unknown as typeof globalThis.Headers;
globalThis.Request = UndiciRequest as unknown as typeof globalThis.Request;
globalThis.Response = UndiciResponse as unknown as typeof globalThis.Response;
