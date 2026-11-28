import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeErasureJournal,
  isErasedSubject,
  readErasureJournal,
} from "@openmapx/core/erasure-journal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAccountMutationContext } from "../../account/account-context";
import type { AuthDatabase } from "../../account/auth-database";
import { runPendingErasures } from "../../privacy/extension-subject-data";
import {
  createUserErasureHooks,
  offlinePackagePrincipalKey,
  readJournalKey,
  userErasureHooks,
} from "../user-erasure";

vi.mock("../../account/admin-invariant", () => ({
  assertAccountDeletionAllowed: vi.fn(async () => {}),
}));

vi.mock("../../privacy/extension-subject-data", () => ({
  runPendingErasures: vi.fn(),
}));

const CURRENT_UID = process.geteuid?.() ?? process.getuid?.() ?? 0;

describe("extension erasures after an account deletion", () => {
  function journal() {
    const files = mkdtempSync(join(tmpdir(), "openmapx-api-erasure-extensions-"));
    const key = randomBytes(32);
    const path = join(files, "journal.jsonl");
    initializeErasureJournal(path, key, new Date());
    writeFileSync(join(files, "journal-key"), key.toString("base64url"), { mode: 0o444 });
    vi.stubEnv("ERASURE_JOURNAL_PATH", path);
    vi.stubEnv("ERASURE_JOURNAL_KEY_FILE", join(files, "journal-key"));
    vi.stubEnv("ERASURE_JOURNAL_KEY_UID", String(CURRENT_UID));
    vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", join(files, "absent-offline-key"));
    return { path, key };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(runPendingErasures).mockReset();
  });

  it("does not wait for extension handlers when an account is deleted", async () => {
    const { path, key } = journal();
    // No offline-package key is configured, so the hook has no rows to remove.
    vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", "");
    vi.mocked(runPendingErasures).mockImplementation(() => new Promise(() => {}));
    const subject = { id: "user-gone", email: "gone@example.test" };

    await userErasureHooks.before(subject);
    expect(runPendingErasures).not.toHaveBeenCalled();
    await expect(userErasureHooks.after(subject)).resolves.toBeUndefined();

    expect(runPendingErasures).toHaveBeenCalledOnce();
    expect(runPendingErasures).toHaveBeenCalledWith();
    const recorded = readErasureJournal(path, key);
    expect(isErasedSubject(recorded, key, subject.id)).toBe(true);
    expect(recorded.completionRecords).toHaveLength(1);
  });

  it("starts the extension erasures only once the account deletion has committed", async () => {
    journal();
    vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", "");
    vi.mocked(runPendingErasures).mockRejectedValue(new Error("not reached by the caller"));
    const afterCommit: Array<() => Promise<void>> = [];
    const subject = { id: "user-in-transaction", email: "tx@example.test" };

    await withAccountMutationContext(
      {
        database: {} as AuthDatabase,
        actorId: subject.id,
        targetId: subject.id,
        action: "delete",
        mutationKey: "erasure-extensions",
        roleAudit: false,
        afterCommit,
        failures: [],
      },
      async () => {
        await userErasureHooks.before(subject);
        await userErasureHooks.after(subject);
      },
    );
    expect(runPendingErasures).not.toHaveBeenCalled();

    for (const complete of afterCommit) await complete();
    expect(runPendingErasures).toHaveBeenCalledOnce();
  });
});

describe("user erasure hooks", () => {
  it("journals the request only once the account row is deleted, then its completion", async () => {
    const events: string[] = [];
    const hooks = createUserErasureHooks({
      check: vi.fn(async () => {
        events.push("checked");
      }),
      request: vi.fn(async () => {
        events.push("requested");
        return "receipt-1";
      }),
      cleanup: vi.fn(async () => {
        events.push("cleaned");
      }),
      complete: vi.fn(async () => {
        events.push("completed");
      }),
    });
    const user = { id: "user-1", email: "person@example.test" };

    await hooks.before(user);
    events.push("deleted");
    await hooks.after(user);

    expect(events).toEqual(["checked", "cleaned", "deleted", "requested", "completed"]);
  });

  it("fails the deletion, so its transaction rolls back, when the request cannot be journalled", async () => {
    const complete = vi.fn();
    const hooks = createUserErasureHooks({
      check: async () => {},
      request: async () => {
        throw new Error("journal unavailable");
      },
      cleanup: async () => {},
      complete,
    });
    const user = { id: "user-1", email: "person@example.test" };

    await hooks.before(user);
    await expect(hooks.after(user)).rejects.toThrow("journal unavailable");
    expect(complete).not.toHaveBeenCalled();
  });

  it("journals nothing when the deletion is refused before the account row is deleted", async () => {
    const request = vi.fn(async () => "receipt-1");
    const cleanup = vi.fn();
    const hooks = createUserErasureHooks({
      check: async () => {
        throw new Error("last administrator");
      },
      request,
      cleanup,
      complete: vi.fn(),
    });

    await expect(hooks.before({ id: "user-1", email: "person@example.test" })).rejects.toThrow(
      "last administrator",
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not report deletion as failed when only the completion marker cannot be appended", async () => {
    const hooks = createUserErasureHooks({
      check: async () => {},
      request: async () => "receipt-1",
      cleanup: async () => {},
      complete: async () => {
        throw new Error("disk became read-only");
      },
    });
    const user = { id: "user-1", email: "person@example.test" };
    await hooks.before(user);
    await expect(hooks.after(user)).resolves.toBeUndefined();
  });
});

describe("erasure journal key loading", () => {
  it("requires the configured 0444 key to have the deployment owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-api-erasure-key-"));
    const path = join(directory, "key");
    const key = Buffer.alloc(32, 17);
    writeFileSync(path, key.toString("base64url"), { mode: 0o444 });

    expect(
      readJournalKey({
        ERASURE_JOURNAL_KEY_FILE: path,
        ERASURE_JOURNAL_KEY_UID: String(CURRENT_UID),
      }),
    ).toEqual(key);
    expect(() =>
      readJournalKey({
        ERASURE_JOURNAL_KEY_FILE: path,
        ERASURE_JOURNAL_KEY_UID: String(CURRENT_UID + 1),
      }),
    ).toThrow(/unexpected owner/i);
  });

  it("rejects a missing or invalid journal key owner setting", () => {
    expect(() => readJournalKey({})).toThrow(/KEY_FILE is required/);
    expect(() =>
      readJournalKey({
        ERASURE_JOURNAL_KEY_FILE: "/unused",
        ERASURE_JOURNAL_KEY_UID: "not-a-uid",
      }),
    ).toThrow(/owner UID is invalid/i);
  });
});

describe("offline-package principal key for account deletion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips the step where no key is configured and the default file is absent", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "openmapx-api-offline-key-")), "absent");
    await expect(offlinePackagePrincipalKey({}, missing)).resolves.toBeUndefined();
  });

  it("reads a configured key", async () => {
    vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_UID", undefined);
    const path = join(mkdtempSync(join(tmpdir(), "openmapx-api-offline-key-")), "key");
    const key = Buffer.alloc(32, 23);
    writeFileSync(path, key.toString("base64url"), { mode: 0o444 });

    await expect(
      offlinePackagePrincipalKey({ OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE: path }, "/unused"),
    ).resolves.toEqual(key);
  });

  it("fails the deletion when a configured key cannot be read", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "openmapx-api-offline-key-")), "absent");
    await expect(
      offlinePackagePrincipalKey({ OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE: missing }, "/unused"),
    ).rejects.toThrow(/missing or unreadable/);
  });
});
