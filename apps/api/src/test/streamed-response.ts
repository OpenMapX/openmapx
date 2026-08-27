const MAX_STREAMED_TEST_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Build a standards-shaped JSON response for fetch-provider tests.
 *
 * Keeping fixtures on the native body stream exercises the same bounded reader
 * as production and prevents `.json()`-only doubles from bypassing that contract.
 */
export function streamedJsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > MAX_STREAMED_TEST_RESPONSE_BYTES) {
    throw new RangeError("streamed test response exceeds fixture size limit");
  }

  return new Response(body, init);
}

export function emptyResponse(status = 500): Response {
  return new Response(null, { status });
}
