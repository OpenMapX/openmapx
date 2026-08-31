import { afterEach, beforeEach, vi } from "vitest";
import { emptyResponse, streamedJsonResponse } from "../../../test/streamed-response.js";

export function geocodingAdapterContract(providerName: string) {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockName(`${providerName} fetch`);
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  return {
    mockFetch,
    mockOk: streamedJsonResponse,
    mockNotOk: (status = 500) => emptyResponse(status),
  };
}
