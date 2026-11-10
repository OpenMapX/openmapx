import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { clientAddressKey, RateLimiter, requestNetworkKey } from "./rate-limit.js";

function fakeRequest(ip: string | undefined, peer: string | undefined): FastifyRequest {
  return { ip, socket: { remoteAddress: peer } } as unknown as FastifyRequest;
}

function fakeReply(): FastifyReply & { statusCode: number } {
  const reply = {
    statusCode: 200,
    header: () => reply,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send: () => reply,
  };
  return reply as unknown as FastifyReply & { statusCode: number };
}

describe("clientAddressKey", () => {
  it.each([
    ["198.51.100.7", "198.51.100.7"],
    ["::ffff:198.51.100.7", "198.51.100.7"],
    ["::FFFF:198.51.100.7", "198.51.100.7"],
    ["::ffff:c633:6407", "198.51.100.7"],
    ["0:0:0:0:0:ffff:198.51.100.7", "198.51.100.7"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["64:ff9b::198.51.100.7", "64:ff9b:0:0::/64"],
  ])("keys %s as %s", (address, key) => {
    expect(clientAddressKey(address)).toBe(key);
  });

  it("puts every non-address into one shared bucket", () => {
    expect(clientAddressKey("not-an-ip")).toBe("invalid");
    expect(clientAddressKey("198.51.100.7:443")).toBe("invalid");
    expect(clientAddressKey(undefined)).toBe("unknown");
  });
});

describe("requestNetworkKey", () => {
  it("normalizes both the forwarded client and the socket peer", () => {
    expect(requestNetworkKey(fakeRequest("2001:db8:1:2::5", "2001:db8:1:2::5"))).toBe(
      "2001:db8:1:2::/64|2001:db8:1:2::/64",
    );
    expect(requestNetworkKey(fakeRequest("2001:db8:1:2::7", "2001:db8:1:2::8"))).toBe(
      requestNetworkKey(fakeRequest("2001:db8:1:2::5", "2001:db8:1:2::5")),
    );
    expect(requestNetworkKey(fakeRequest("::ffff:203.0.113.4", "::ffff:172.18.0.3"))).toBe(
      "203.0.113.4|172.18.0.3",
    );
  });
});

describe("RateLimiter bucket cap", () => {
  it("evicts the least recently used bucket instead of growing without bound", async () => {
    const limiter = new RateLimiter({
      max: 1,
      windowMs: 60_000,
      maxBuckets: 3,
      keyFn: (request) => request.ip,
    });
    const hit = async (ip: string) => {
      const reply = fakeReply();
      await limiter.preHandler()(fakeRequest(ip, ip), reply);
      return reply.statusCode;
    };

    expect(await hit("198.51.100.1")).toBe(200);
    expect(await hit("198.51.100.2")).toBe(200);
    expect(await hit("198.51.100.3")).toBe(200);
    // Touching .1 makes .2 the least recently used.
    expect(await hit("198.51.100.1")).toBe(429);
    expect(await hit("198.51.100.4")).toBe(200);
    expect(limiter.size).toBe(3);

    expect(await hit("198.51.100.1")).toBe(429);
    expect(await hit("198.51.100.3")).toBe(429);
    expect(await hit("198.51.100.2")).toBe(200);
    expect(limiter.size).toBe(3);
  });
});
