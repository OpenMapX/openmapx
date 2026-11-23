import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
import { createMigratedPostgresContainer } from "../test/postgres-fixture";

const SMTP_PASSWORD = "smtp-password-in-clear-7c1f";
const MAPTILER_KEY = "maptiler-key-in-clear-52ab";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

dbDescribe("secret settings encrypted at rest", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresContainer>>;
  let keys: string;
  let keyFile: string;
  let settings: typeof import("./settings");

  const writeKey = (name: string, contents: string) => {
    const path = join(keys, name);
    writeFileSync(path, contents, { mode: 0o444 });
    return path;
  };

  beforeAll(async () => {
    fixture = await createMigratedPostgresContainer();
    keys = mkdtempSync(join(tmpdir(), "openmapx-secrets-key-"));
    keyFile = writeKey("secrets-key", randomBytes(32).toString("base64url"));
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
    settings = await import("./settings");
  }, 90_000);

  afterAll(async () => {
    vi.doUnmock("../db");
    vi.unstubAllEnvs();
    await fixture?.stop();
    if (keys) rmSync(keys, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
    vi.stubEnv("SMTP_PASS", undefined);
    vi.stubEnv("MAPTILER_KEY", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", keyFile);
    await fixture.sql`DELETE FROM system_secret`;
    await fixture.sql`DELETE FROM system_settings`;
  });

  it("stores a saved secret setting only as ciphertext in system_secret", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtpPassword", value: SMTP_PASSWORD },
        { key: "smtpHost", value: "mail.example.test" },
      ],
      "loopback",
      fixture.db,
    );

    expect(await fixture.sql`SELECT key, value FROM system_settings ORDER BY key`).toEqual([
      { key: "smtpHost", value: "mail.example.test" },
    ]);
    const rows = await fixture.sql<
      { key: string; ciphertext: string; iv: string; tag: string; updated_by: string | null }[]
    >`SELECT key, ciphertext, iv, tag, updated_by FROM system_secret`;
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.key).toBe("smtpPassword");
    expect(row?.updated_by).toBeNull();
    expect(JSON.stringify(row)).not.toContain(SMTP_PASSWORD);
    expect(Buffer.from(row?.ciphertext ?? "", "base64").toString("utf8")).not.toContain(
      SMTP_PASSWORD,
    );
  });

  it("returns the stored value through the loader and reports it only as configured", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtpPassword", value: SMTP_PASSWORD },
        { key: "maptilerApiKey", value: MAPTILER_KEY },
      ],
      "loopback",
      fixture.db,
    );

    expect(await settings.loadSecretSettings(fixture.db)).toEqual({
      smtpPassword: SMTP_PASSWORD,
      maptilerApiKey: MAPTILER_KEY,
    });
    const groups = await settings.resolveSettings(fixture.db);
    const smtp = groups.flatMap((group) => group.settings).find((s) => s.key === "smtpPassword");
    expect(smtp).toMatchObject({ value: "***", source: "database", secret: true });
    expect(JSON.stringify(groups)).not.toContain(SMTP_PASSWORD);
  });

  it("lets an environment override take precedence over the stored secret", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    vi.stubEnv("SMTP_PASS", "from-the-environment");
    const groups = await settings.resolveSettings(fixture.db);
    expect(
      groups.flatMap((group) => group.settings).find((s) => s.key === "smtpPassword"),
    ).toMatchObject({ value: "***", source: "env", envOverride: true });
  });

  it("removes a secret setting saved as empty", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    await settings.saveSystemSettings([{ key: "smtpPassword", value: "" }], "loopback", fixture.db);
    expect(await fixture.sql`SELECT key FROM system_secret`).toEqual([]);
    expect(await fixture.sql`SELECT key FROM system_settings`).toEqual([]);
    expect(await settings.loadSecretSettings(fixture.db)).toEqual({});
  });

  it("attributes the change to the administrator and forgets them when the account goes", async () => {
    await fixture.sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('secret-admin', 'Secret admin', 'secret-admin@example.test', true, now(), now())`;
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "secret-admin",
      fixture.db,
    );
    expect(await fixture.sql`SELECT updated_by FROM system_secret`).toEqual([
      { updated_by: "secret-admin" },
    ]);
    await fixture.sql`DELETE FROM "user" WHERE id = 'secret-admin'`;
    expect(await fixture.sql`SELECT updated_by FROM system_secret`).toEqual([{ updated_by: null }]);
  });

  it("returns the value after an API restart with the same key file", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    // A fresh process: new module instances, a new key read and a new connection.
    vi.resetModules();
    const connection = postgres(fixture.connectionUri, { max: 1 });
    try {
      const restartedDb = drizzle(connection, { schema });
      vi.doMock("../db", () => ({ db: restartedDb, sql: connection }));
      const restarted = await import("./settings");
      expect(restarted).not.toBe(settings);
      expect(await restarted.loadSecretSettings(restartedDb)).toEqual({
        smtpPassword: SMTP_PASSWORD,
      });
    } finally {
      vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
      await connection.end({ timeout: 2 });
    }
  });

  it("keeps the plaintext out of a pg_dump of the table", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    const dump = await fixture.container.exec([
      "pg_dump",
      "--username=postgres",
      "--dbname=openmapx_test",
      "--table=public.system_secret",
      "--data-only",
      "--column-inserts",
    ]);
    expect(dump.exitCode).toBe(0);
    expect(dump.output).toContain("INSERT INTO public.system_secret");
    expect(dump.output).toContain("'smtpPassword'");
    expect(dump.output).not.toContain(SMTP_PASSWORD);
  });

  it("refuses to save or read a secret without a key, saying how to get one", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", join(keys, "absent"));
    await expect(settings.loadSecretSettings(fixture.db)).rejects.toThrow(
      /smtpPassword cannot be read: Secrets key file is missing or unreadable \(OPENMAPX_SECRETS_KEY_FILE\); run `pnpm openmapx compose render`/,
    );
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/Secrets key file is missing or unreadable/);

    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/secrets key is not configured: run `pnpm openmapx compose render`/);
  });

  it("refuses a key that is not the one the value was saved with", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    vi.stubEnv(
      "OPENMAPX_SECRETS_KEY_FILE",
      writeKey("other-key", randomBytes(32).toString("base64url")),
    );
    await expect(settings.loadSecretSettings(fixture.db)).rejects.toThrow(
      /smtpPassword cannot be read: A stored secret cannot be decrypted with the configured secrets key/,
    );
  });

  it("refuses the former 64-character hex key format", async () => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writeKey("hex-key", randomBytes(32).toString("hex")));
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/43 base64url characters.*64-character hex format is not accepted/);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY", randomBytes(32).toString("hex"));
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/OPENMAPX_SECRETS_KEY must hold 32 random bytes/);
  });

  it("accepts the same key in OPENMAPX_SECRETS_KEY for development but not beside the file", async () => {
    const value = randomBytes(32).toString("base64url");
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY", value);
    await settings.saveSystemSettings(
      [{ key: "smtpPassword", value: SMTP_PASSWORD }],
      "loopback",
      fixture.db,
    );
    vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writeKey("same-key", value));
    expect(await settings.loadSecretSettings(fixture.db)).toEqual({ smtpPassword: SMTP_PASSWORD });
    vi.stubEnv("OPENMAPX_SECRETS_KEY", value);
    await expect(settings.loadSecretSettings(fixture.db)).rejects.toThrow(
      /Set either OPENMAPX_SECRETS_KEY_FILE or OPENMAPX_SECRETS_KEY, not both/,
    );
  });
});
