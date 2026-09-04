import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import {
  createPrivacyDataRequest,
  privacyArtifactDownloadUrl,
  startPrivacyReauthentication,
} from "./privacy";

afterEach(() => vi.restoreAllMocks());

describe("privacy API client", () => {
  it("sends an idempotency key for mutations without exposing a bearer token", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ id: "request-1" } as never);
    await createPrivacyDataRequest();
    expect(post).toHaveBeenCalledWith(
      "/api/privacy/data-requests",
      expect.objectContaining({ kind: "access_and_portability" }),
      { headers: { "Idempotency-Key": expect.stringMatching(/^privacy-/) } },
    );
    expect(JSON.stringify(post.mock.calls[0])).not.toMatch(/token|secret|password/i);
  });

  it("keeps download URLs path-bound and query-free", () => {
    const url = privacyArtifactDownloadUrl("request/unsafe", "artifact?unsafe");
    expect(url).toContain("request%2Funsafe");
    expect(url).toContain("artifact%3Funsafe");
    expect(url).not.toContain("?");
  });

  it("starts reauthentication with a fresh idempotency key", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ challengeId: "c" } as never);
    await startPrivacyReauthentication("request", "artifact");
    expect(post.mock.calls[0]?.[2]).toMatchObject({
      headers: { "Idempotency-Key": expect.any(String) },
    });
  });
});
