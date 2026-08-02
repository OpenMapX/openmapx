import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPinToSource,
  decodeTransportApisLock,
  resolveTransportApisCandidate,
  transportApisLockJson,
  writeTransportApisLock,
} from "../src/commands/transport-apis-pin";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

const LOCK = {
  schemaVersion: 1 as const,
  source: "public-transport-transport-apis" as const,
  ref: "v1",
  commit: "a".repeat(40),
  entryCount: 1,
  lockedAt: "2026-08-03T12:00:00.000Z",
  lockedBy: "tester",
  comment: "test lock",
};

describe("transport-apis pin helpers", () => {
  it("decodes and serializes a valid lock", () => {
    const decoded = decodeTransportApisLock(JSON.parse(transportApisLockJson(LOCK)));
    expect(decoded).toEqual(LOCK);
    expect(transportApisLockJson(decoded)).toContain(`"commit": "${"a".repeat(40)}"`);
  });

  it("rewrites only the pin literals", () => {
    const source = `
export const TRANSPORT_APIS_REF = "old";
export const TRANSPORT_APIS_COMMIT = "${"b".repeat(40)}";
export const TRANSPORT_APIS_LOCKED_AT = "old-time";
`;
    const updated = applyPinToSource(source, LOCK);
    expect(updated).toContain('TRANSPORT_APIS_REF = "v1"');
    expect(updated).toContain(`TRANSPORT_APIS_COMMIT = "${"a".repeat(40)}"`);
    expect(updated).toContain('TRANSPORT_APIS_LOCKED_AT = "2026-08-03T12:00:00.000Z"');
  });

  it("writes the lock atomically at the repository path", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "openmapx-transport-apis-pin-"));
    mkdirSync(join(temporaryRoot, "infra", "docker"), { recursive: true });

    writeTransportApisLock(temporaryRoot, LOCK);

    expect(
      JSON.parse(
        readFileSync(join(temporaryRoot, "infra", "docker", "transport-apis.lock.json"), "utf8"),
      ),
    ).toMatchObject(LOCK);
  });

  it("resolves a real candidate from injected repository, commit, listing, and file responses", async () => {
    const commit = "e".repeat(40);
    const fetchStub = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === "https://api.github.com/repos/public-transport/transport-apis") {
        return new Response(JSON.stringify({ default_branch: "v1" }));
      }
      if (url.endsWith("/commits/v1")) return new Response(JSON.stringify({ sha: commit }));
      if (url.includes("data.jsdelivr.com")) {
        return new Response(
          JSON.stringify({
            files: [
              {
                name: "data",
                type: "directory",
                files: [{ name: "example-otp.json", type: "file" }],
              },
            ],
          }),
        );
      }
      if (url.includes("cdn.jsdelivr.net")) {
        return new Response(
          JSON.stringify({
            name: "Example OTP",
            type: { otpGraphQl: {} },
            coverage: { realtimeCoverage: { region: ["DE"] } },
            options: { endpoint: "https://otp.example/graphql" },
          }),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const result = await resolveTransportApisCandidate(
      "tester",
      fetchStub as typeof fetch,
      () => new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(result.lock).toMatchObject({
      ref: "v1",
      commit,
      entryCount: 1,
      lockedAt: "2026-08-03T12:00:00.000Z",
      lockedBy: "tester",
    });
    expect(result.protocolCounts).toEqual(new Map([["otpGraphQl", 1]]));
    expect(result.rejectedIds).toEqual([]);
  });
});
