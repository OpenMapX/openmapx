import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

// Import AFTER vi.mock so the mocked lookup is captured. We re-import the
// mocked module to drive the mock.
import { lookup as dnsLookup } from "node:dns/promises";
import { assertResolvesToPublicIp } from "../utils/safe-download";

// dnsLookup has overloads that confuse vi.mocked; cast to a simple mock.
const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  lookupMock.mockReset();
});

describe("assertResolvesToPublicIp", () => {
  it("passes for a public IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertResolvesToPublicIp("example.com")).resolves.toBeUndefined();
  });

  it("rejects when DNS returns loopback IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects when DNS returns a private RFC1918 IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects link-local IPv6", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "fe80::1", family: 6 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects IPv4-mapped IPv6 loopback", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects when ANY returned record is private (dual-stack rebinding guard)", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects when DNS returns no records", async () => {
    lookupMock.mockResolvedValueOnce([]);
    await expect(assertResolvesToPublicIp("unknown.test")).rejects.toThrow(/No DNS records/);
  });
});
