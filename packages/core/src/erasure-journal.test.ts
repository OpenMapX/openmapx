import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendErasureCompleted,
  appendErasureRequest,
  compactErasureJournal,
  initializeErasureJournal,
  isErasedSubject,
  readErasureJournal,
} from "./erasure-journal";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");

describe("erasure journal", () => {
  it("records only a pseudonymous subject and retains its coverage marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, new Date("2026-08-01T00:00:00.000Z"));

    const receiptId = await appendErasureRequest(
      path,
      KEY,
      "user-123",
      new Date("2026-08-03T00:00:00.000Z"),
    );
    await appendErasureCompleted(path, receiptId, new Date("2026-08-03T00:00:01.000Z"));

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("user-123");
    const journal = readErasureJournal(path);
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
      `${JSON.stringify({ version: 1, phase: "requested", receiptId: "6ee7f3f2-cde2-4ad8-8ebf-72dba5915b51", subjectDigest: "bad", at: "2026-08-03T00:00:00.000Z" })}\n`,
    );
    expect(() => readErasureJournal(path)).toThrow(/coverage|digest/i);
  });

  it("compacts requests only after they are older than the restore safety window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path, new Date("2026-01-01T00:00:00.000Z"));
    await appendErasureRequest(path, KEY, "old-user", new Date("2026-07-01T00:00:00.000Z"));
    await appendErasureRequest(path, KEY, "recent-user", new Date("2026-08-01T00:00:00.000Z"));

    compactErasureJournal(path, new Date("2026-07-25T00:00:00.000Z"));

    const journal = readErasureJournal(path);
    expect(isErasedSubject(journal, KEY, "old-user")).toBe(false);
    expect(isErasedSubject(journal, KEY, "recent-user")).toBe(true);
    expect(journal.coverageStartedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("fails closed rather than racing a concurrent journal operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-erasure-"));
    const path = join(directory, "journal.jsonl");
    initializeErasureJournal(path);
    mkdirSync(`${path}.lock`);

    await expect(appendErasureRequest(path, KEY, "user-123")).rejects.toThrow(/locked/i);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
