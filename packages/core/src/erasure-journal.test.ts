import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendErasureCompleted,
  appendErasureRequest,
  assertErasureJournalKey,
  compactErasureJournal,
  initializeErasureJournal,
  isErasedSubject,
  readErasureJournal,
  readErasureJournalKeyFile,
} from "./erasure-journal";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const WRONG_KEY = Buffer.from("abcdef0123456789abcdef0123456789");
const CURRENT_UID = process.geteuid?.() ?? process.getuid?.() ?? 0;

describe("erasure journal", () => {
  it("records only a pseudonymous subject and retains its coverage marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY, new Date("2026-08-01T00:00:00.000Z"));

    const receiptId = await appendErasureRequest(
      path,
      KEY,
      "user-123",
      new Date("2026-08-03T00:00:00.000Z"),
    );
    await appendErasureCompleted(path, KEY, receiptId, new Date("2026-08-03T00:00:01.000Z"));

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("user-123");
    const journal = readErasureJournal(path, KEY);
    expect(journal.coverageStartedAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(journal.requests).toHaveLength(1);
    expect(journal.requests[0]?.receiptId).toBe(receiptId);
    expect(journal.completedReceiptIds.has(receiptId)).toBe(true);
    expect(isErasedSubject(journal, KEY, "user-123")).toBe(true);
    expect(isErasedSubject(journal, KEY, "different-user")).toBe(false);
  });

  it("rejects records before a coverage marker and malformed digests", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ version: 2, phase: "requested", receiptId: "6ee7f3f2-cde2-4ad8-8ebf-72dba5915b51", subjectDigest: "bad", at: "2026-08-03T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(() => readErasureJournal(path, KEY)).toThrow(/coverage|digest/i);
  });

  it("rejects a valid but different key before replay, even with no requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY, new Date("2026-08-01T00:00:00.000Z"));

    expect(() => readErasureJournal(path, WRONG_KEY)).toThrow(/key.*does not match/i);
    expect(() => initializeErasureJournal(path, WRONG_KEY)).toThrow(/key.*does not match/i);
    await expect(appendErasureRequest(path, WRONG_KEY, "user-123")).rejects.toThrow(
      /key.*does not match/i,
    );
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("makes an already-read journal fail closed when queried with the wrong key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY);
    await appendErasureRequest(path, KEY, "erased-user");
    const journal = readErasureJournal(path, KEY);

    expect(() => assertErasureJournalKey(journal, WRONG_KEY)).toThrow(/key.*does not match/i);
    expect(() => isErasedSubject(journal, WRONG_KEY, "erased-user")).toThrow(
      /key.*does not match/i,
    );
  });

  it("rejects unsupported journal versions without a recovery path", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, phase: "coverage", at: "2026-08-01T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );

    expect(() => readErasureJournal(path, KEY)).toThrow(/Invalid erasure journal record/i);
    expect(() => initializeErasureJournal(path, KEY)).toThrow(/Invalid erasure journal record/i);
  });

  it("compacts requests only after they are older than the restore safety window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY, new Date("2026-01-01T00:00:00.000Z"));
    await appendErasureRequest(path, KEY, "old-user", new Date("2026-07-01T00:00:00.000Z"));
    await appendErasureRequest(path, KEY, "recent-user", new Date("2026-08-01T00:00:00.000Z"));

    compactErasureJournal(path, KEY, new Date("2026-07-25T00:00:00.000Z"));

    const journal = readErasureJournal(path, KEY);
    expect(isErasedSubject(journal, KEY, "old-user")).toBe(false);
    expect(isErasedSubject(journal, KEY, "recent-user")).toBe(true);
    expect(journal.coverageStartedAt.toISOString()).toBe("2026-07-25T00:00:00.000Z");

    compactErasureJournal(path, KEY, new Date("2026-06-01T00:00:00.000Z"));
    const afterRetentionIncrease = readErasureJournal(path, KEY);
    expect(afterRetentionIncrease.coverageStartedAt.toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(() => assertErasureJournalKey(afterRetentionIncrease, WRONG_KEY)).toThrow(
      /key.*does not match/i,
    );
  });

  it("validates the key before completing or compacting the journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY);
    const receiptId = await appendErasureRequest(path, KEY, "erased-user");

    await expect(appendErasureCompleted(path, WRONG_KEY, receiptId)).rejects.toThrow(
      /key.*does not match/i,
    );
    expect(() => compactErasureJournal(path, WRONG_KEY, new Date())).toThrow(
      /key.*does not match/i,
    );
  });

  it("fails closed rather than racing a concurrent journal operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY);
    mkdirSync(`${path}.lock`);

    await expect(appendErasureRequest(path, KEY, "user-123")).rejects.toThrow(/locked/i);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("reads only a canonical, bounded, single-link 0444 journal key file", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-key-"));
    const encoded = KEY.toString("base64url");
    const path = join(directory, "key");
    writeFileSync(path, encoded, { mode: 0o444 });

    expect(readErasureJournalKeyFile(path, CURRENT_UID)).toEqual(KEY);
    expect(() => readErasureJournalKeyFile(path, CURRENT_UID + 1)).toThrow(/unexpected owner/i);

    chmodSync(path, 0o400);
    expect(() => readErasureJournalKeyFile(path, CURRENT_UID)).toThrow(/0444/);
    chmodSync(path, 0o444);
    linkSync(path, join(directory, "second-link"));
    expect(() => readErasureJournalKeyFile(path, CURRENT_UID)).toThrow(/exactly one link/i);
  });

  it("rejects symlinked and oversized journal key files", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-key-"));
    const target = join(directory, "target");
    const symlink = join(directory, "key-link");
    writeFileSync(target, KEY.toString("base64url"), { mode: 0o444 });
    symlinkSync(target, symlink);
    expect(() => readErasureJournalKeyFile(symlink, CURRENT_UID)).toThrow(/regular file/i);

    const oversized = join(directory, "oversized");
    writeFileSync(oversized, "x".repeat(4_097), { mode: 0o444 });
    expect(() => readErasureJournalKeyFile(oversized, CURRENT_UID)).toThrow(/size limit/i);
  });

  it("rejects a hard-linked journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY);
    linkSync(path, join(directory, "journal-second-link.jsonl"));

    expect(() => readErasureJournal(path, KEY)).toThrow(/exactly one link/i);
  });

  it("rejects symlinked and over-permissive journals", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, KEY);
    const symlink = join(directory, "journal-link.jsonl");
    symlinkSync(path, symlink);

    expect(() => readErasureJournal(symlink, KEY)).toThrow(/regular file/i);
    chmodSync(path, 0o640);
    expect(() => readErasureJournal(path, KEY)).toThrow(/0600 permissions/i);
  });

  it("rejects a journal that exceeds its read bound", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    writeFileSync(path, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });

    expect(() => readErasureJournal(path, KEY)).toThrow(/size limit/i);
  });
});
