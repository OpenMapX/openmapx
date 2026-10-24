import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMUNITY_RECORD_VERSION,
  type CommunityRepositoryRecord,
  communityRecordFileName,
  loadRecordedCommunityServices,
  manifestSha256,
  parseCommunityRepositoryRecord,
  readCommunityRepositoryRecord,
  verifyRecordedRepository,
} from "../community-repository-records";

const REPOSITORY = "0123456789abcdef";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(id: string, image = `registry.example.test/${id}`): string {
  return JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    quality: "community",
    container: { image, tag: "1", digest: `sha256:${"a".repeat(64)}` },
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-community-records-"));
  roots.push(root);
  const community = join(root, "services", ".community");
  const checkout = join(community, REPOSITORY);
  mkdirSync(join(checkout, "svc"), { recursive: true });
  writeFileSync(join(checkout, "svc", "service.json"), manifest("community-one"));
  const digest = (path: string) =>
    manifestSha256(readFileSync(join(checkout, path, "service.json")));
  const record = (
    overrides: Partial<CommunityRepositoryRecord> = {},
  ): CommunityRepositoryRecord => ({
    version: COMMUNITY_RECORD_VERSION,
    repository: REPOSITORY,
    url: "https://example.test/one.git",
    commit: "1".repeat(40),
    extensionId: "one",
    manifests: [{ path: "svc", sha256: digest("svc") }],
    pending: null,
    ...overrides,
  });
  const write = (value: unknown, mode = 0o644) =>
    writeFileSync(join(community, communityRecordFileName(REPOSITORY)), JSON.stringify(value), {
      mode,
    });
  return { root, community, checkout, digest, record, write };
}

describe("community repository records", () => {
  it("loads exactly the recorded manifests of each recorded repository", () => {
    const { root, checkout, record, write } = fixture();
    write(record());
    mkdirSync(join(checkout, "unlisted"));
    writeFileSync(join(checkout, "unlisted", "service.json"), manifest("unlisted"));
    const loaded = loadRecordedCommunityServices(root);
    expect(loaded.map(({ service }) => service.manifest.id)).toEqual(["community-one"]);
    expect(loaded[0]?.service).toMatchObject({
      directory: join(checkout, "svc"),
      isBuiltIn: false,
    });
  });

  it("accepts either side of a transaction in progress, or a briefly absent checkout", () => {
    const { checkout, record } = fixture();
    const previous = record();
    writeFileSync(join(checkout, "svc", "service.json"), manifest("community-two"));
    const next = {
      url: "https://example.test/one.git",
      commit: "2".repeat(40),
      extensionId: "one",
      manifests: [{ path: "svc", sha256: manifestSha256(Buffer.from(manifest("community-two"))) }],
    };
    const pending = record({
      manifests: previous.manifests,
      pending: {
        transactionId: `txn1_${"a".repeat(24)}`,
        phase: "prepared",
        previous: {
          url: previous.url,
          commit: previous.commit,
          extensionId: previous.extensionId,
          manifests: previous.manifests,
        },
        next,
        recovery: { selectionBefore: null, touchedServiceIds: [], previouslyEnabledServiceIds: [] },
      },
    });
    expect(
      verifyRecordedRepository(checkout, pending).map(({ service }) => service.manifest.id),
    ).toEqual(["community-two"]);
    writeFileSync(join(checkout, "svc", "service.json"), manifest("community-one"));
    expect(
      verifyRecordedRepository(checkout, pending).map(({ service }) => service.manifest.id),
    ).toEqual(["community-one"]);
    rmSync(checkout, { recursive: true });
    expect(verifyRecordedRepository(checkout, pending)).toEqual([]);
    // Outside a transaction the checkout must be there and match.
    expect(() => verifyRecordedRepository(checkout, previous)).toThrow();
  });

  it("refuses records the agent did not write", () => {
    const { community, record, write } = fixture();
    write(record());
    expect(() => readCommunityRepositoryRecord(community, REPOSITORY, 4_242_424)).toThrow(
      `Repository record ${REPOSITORY} is invalid`,
    );
    expect(readCommunityRepositoryRecord(community, "fedcba9876543210")).toBeNull();
  });

  it.each([
    ["an escaping path", { manifests: [{ path: "../outside", sha256: "a".repeat(64) }] }],
    ["a hidden path", { manifests: [{ path: ".git", sha256: "a".repeat(64) }] }],
    ["a deep path", { manifests: [{ path: "a/b/c/d/e", sha256: "a".repeat(64) }] }],
    ["a bad digest", { manifests: [{ path: "svc", sha256: "not-a-digest" }] }],
    [
      "a duplicate path",
      {
        manifests: [
          { path: "svc", sha256: "a".repeat(64) },
          { path: "svc", sha256: "b".repeat(64) },
        ],
      },
    ],
    ["no manifests", { manifests: [] }],
    ["manifests without a commit", { commit: null }],
    ["version 1", { version: 1 }],
  ])("rejects a record with %s", (_label, overrides) => {
    const { record } = fixture();
    expect(() => parseCommunityRepositoryRecord({ ...record(), ...overrides }, REPOSITORY)).toThrow(
      `Repository record ${REPOSITORY} is invalid`,
    );
  });

  it("fails closed when a recorded manifest changed or no longer passes the rules", () => {
    const { root, checkout, record, write } = fixture();
    write(record());
    writeFileSync(
      join(checkout, "svc", "service.json"),
      manifest("community-one", "attacker.example.test/one"),
    );
    expect(() => loadRecordedCommunityServices(root)).toThrow(
      `Community repository ${REPOSITORY} no longer matches the service manifests the operations agent recorded when it installed it. Delete services/.community/${REPOSITORY} and services/.community/.repository-${REPOSITORY}.json, then install its extension again.`,
    );
  });

  it("loads nothing without a community directory", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-community-records-empty-"));
    roots.push(root);
    expect(loadRecordedCommunityServices(root)).toEqual([]);
  });
});
