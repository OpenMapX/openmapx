import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSPORT_APIS_COMMIT } from "../pin";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchRegistryEntries } = await import("../fetcher");

const VALID_ENTRY = {
  name: "ÖBB",
  type: { hafasMgate: {} },
  coverage: { realtimeCoverage: { region: ["AT"] } },
  options: { endpoint: "https://fahrplan.oebb.at/bin/mgate.exe" },
};

function makeJsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

function listing(...paths: string[]) {
  return { files: paths.map((path) => ({ name: `/${path}` })) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("pinned transit registry fetches", () => {
  it("fetches both the listing and files at the immutable revision", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(listing("data/at/oebb-hafas-mgate.json")))
      .mockResolvedValueOnce(makeJsonResponse(VALID_ENTRY));

    const entries = await fetchRegistryEntries();
    expect(entries).toHaveLength(1);

    for (const [input] of mockFetch.mock.calls) {
      const url = String(input);
      expect(url).toContain(TRANSPORT_APIS_COMMIT);
      expect(url).not.toContain("transport-apis@HEAD");
      expect(url).not.toContain("transport-apis@v1");
      expect(url).not.toContain("/transport-apis/v1/");
    }
  });

  it("pins the GitHub fallback tree and raw file URLs", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("JSDelivr unavailable"))
      .mockResolvedValueOnce(
        makeJsonResponse({
          tree: [{ path: "data/at/oebb-hafas-mgate.json", type: "blob" }],
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse(VALID_ENTRY));

    const entries = await fetchRegistryEntries();
    expect(entries).toHaveLength(1);
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe(
      `https://api.github.com/repos/public-transport/transport-apis/git/trees/${TRANSPORT_APIS_COMMIT}?recursive=1`,
    );
    expect(String(mockFetch.mock.calls[2]?.[0])).toContain(
      `/${TRANSPORT_APIS_COMMIT}/data/at/oebb-hafas-mgate.json`,
    );
  });

  it("drops a private-host endpoint while preserving a valid sibling", async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeJsonResponse(listing("data/at/oebb-hafas-mgate.json", "data/us/private-otp.json")),
      )
      .mockResolvedValueOnce(makeJsonResponse(VALID_ENTRY))
      .mockResolvedValueOnce(
        makeJsonResponse({
          ...VALID_ENTRY,
          name: "Private",
          type: { otpGraphQl: {} },
          options: { endpoint: "http://127.0.0.1:8080/otp" },
        }),
      );

    const entries = await fetchRegistryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("ÖBB");
  });

  it("drops a credentialed plain-HTTP endpoint", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(listing("data/us/insecure-otp.json")))
      .mockResolvedValueOnce(
        makeJsonResponse({
          ...VALID_ENTRY,
          name: "Insecure",
          type: { otpGraphQl: {} },
          options: { endpoint: "http://api.example.org/graphql", apiKey: "x" },
        }),
      );

    await expect(fetchRegistryEntries()).resolves.toEqual([]);
  });

  it.each([
    ["array", []],
    ["missing type", { name: "Missing type", coverage: VALID_ENTRY.coverage, options: {} }],
    ["string options", { ...VALID_ENTRY, options: "unexpected" }],
  ])("drops an unexpected %s registry shape without losing a good sibling", async (_name, bad) => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(listing("data/at/good.json", "data/at/bad.json")))
      .mockResolvedValueOnce(makeJsonResponse(VALID_ENTRY))
      .mockResolvedValueOnce(makeJsonResponse(bad));

    const entries = await fetchRegistryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("ÖBB");
  });

  it("continues dropping entries without coverage", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(listing("data/xx/no-coverage.json")))
      .mockResolvedValueOnce(
        makeJsonResponse({
          ...VALID_ENTRY,
          name: "No coverage",
          coverage: {},
          options: {},
        }),
      );

    await expect(fetchRegistryEntries()).resolves.toEqual([]);
  });
});
