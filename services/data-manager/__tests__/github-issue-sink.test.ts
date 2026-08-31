import { describe, expect, it, vi } from "vitest";
import {
  type CreateGithubIssueSinkOptions,
  createGithubIssueSink,
  type GithubIssueSink,
} from "../src/jobs/github-issue-sink.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireSink(options: CreateGithubIssueSinkOptions): GithubIssueSink {
  const sink = createGithubIssueSink(options);
  if (!sink) throw new Error("Expected configured GitHub issue sink");
  return sink;
}

describe("createGithubIssueSink", () => {
  it("returns null for incomplete or blank configuration", () => {
    expect(createGithubIssueSink({})).toBeNull();
    expect(createGithubIssueSink({ token: "token" })).toBeNull();
    expect(createGithubIssueSink({ repository: "openmapx/openmapx" })).toBeNull();
    expect(createGithubIssueSink({ token: "  ", repository: "openmapx/openmapx" })).toBeNull();
    expect(createGithubIssueSink({ token: "token", repository: "  " })).toBeNull();
  });

  it("finds an exact open title across result pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      title: `Unrelated issue ${index}`,
      html_url: `https://github.com/openmapx/openmapx/issues/${index + 1}`,
    }));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            title: "Stale transit feed: de/vbb",
            html_url: "https://github.com/openmapx/openmapx/issues/101",
          },
        ]),
      );
    const sink = requireSink({
      token: "token",
      repository: "openmapx/openmapx",
      fetch: request,
    });

    await expect(sink.findOpenIssueByTitle?.("Stale transit feed: de/vbb")).resolves.toBe(
      "https://github.com/openmapx/openmapx/issues/101",
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/openmapx/openmapx/issues?state=open&per_page=100&page=1",
      {
        headers: {
          Authorization: "Bearer token",
          Accept: "application/vnd.github+json",
        },
      },
    );
    expect(request.mock.calls[1]?.[0]).toContain("page=2");
  });

  it("returns null after the final page without a matching title", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const sink = requireSink({
      token: "token",
      repository: "openmapx/openmapx",
      fetch: request,
    });

    await expect(sink.findOpenIssueByTitle?.("Missing issue")).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("creates an issue with the shared headers and payload", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ html_url: "https://github.com/openmapx/openmapx/issues/12" }, 201),
      );
    const sink = requireSink({
      token: " token ",
      repository: " openmapx/openmapx ",
      fetch: request,
    });

    await expect(sink.createIssue("Alert title", "Alert body")).resolves.toBe(
      "https://github.com/openmapx/openmapx/issues/12",
    );
    expect(request).toHaveBeenCalledWith("https://api.github.com/repos/openmapx/openmapx/issues", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Alert title", body: "Alert body" }),
    });
  });

  it("reports HTTP failures without exposing the token", async () => {
    const token = "SECRET-GITHUB-TOKEN";
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );
    const sink = requireSink({
      token,
      repository: "openmapx/openmapx",
      fetch: request,
    });

    const error = await sink.findOpenIssueByTitle?.("Alert title").catch((cause) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("GitHub list issues failed: 503 Service Unavailable");
    expect((error as Error).message).not.toContain(token);

    const createError = await sink.createIssue("Alert title", "Alert body").catch((cause) => cause);
    expect(createError).toBeInstanceOf(Error);
    expect((createError as Error).message).toBe(
      "GitHub create issue failed: 503 Service Unavailable",
    );
    expect((createError as Error).message).not.toContain(token);
  });

  it("rejects malformed list and create responses", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ issues: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 12 }, 201));
    const sink = requireSink({
      token: "token",
      repository: "openmapx/openmapx",
      fetch: request,
    });

    await expect(sink.findOpenIssueByTitle?.("Alert title")).rejects.toThrow(
      "GitHub list issues returned an invalid response",
    );
    await expect(sink.createIssue("Alert title", "Alert body")).rejects.toThrow(
      "GitHub create issue returned an invalid response",
    );
  });
});
