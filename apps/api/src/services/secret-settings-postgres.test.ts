import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
import { createMigratedPostgresContainer } from "../test/postgres-fixture";

const SMTP_PASSWORD = "smtp-password-in-clear-7c1f";
const MAPTILER_KEY = "maptiler-key-in-clear-52ab";
const ALL_SECRETS = [
  "emaillabs.appKey",
  "emaillabs.secretKey",
  "lettermint.apiToken",
  "smtp.password",
  "maptiler.apiKey",
];

/** The stored secrets among `keys`, decrypted; a setting without a value is left out. */
async function secretValues(
  settings: typeof import("./settings"),
  keys: readonly string[],
  database: unknown,
): Promise<Record<string, unknown>> {
  const values = await settings.resolveSettingValues(keys, { database: database as never });
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

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
    vi.stubEnv("OPENMAPX_SECRETS_KEY_UID", undefined);
    for (const name of [
      "EMAILLABS_APP_KEY",
      "EMAILLABS_SECRET_KEY",
      "EMAILLABS_SMTP_ACCOUNT",
      "LETTERMINT_API_TOKEN",
      "SMTP_HOST",
    ])
      vi.stubEnv(name, undefined);
    vi.stubEnv("SMTP_PASSWORD", undefined);
    vi.stubEnv("MAPTILER_API_KEY", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", keyFile);
    await fixture.sql`DELETE FROM system_secret`;
    await fixture.sql`DELETE FROM system_setting`;
  });

  it("stores a saved secret setting only as ciphertext in system_secret", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtp.password", value: SMTP_PASSWORD },
        { key: "smtp.host", value: "mail.example.test" },
      ],
      null,
      fixture.db,
    );

    expect(await fixture.sql`SELECT key, value FROM system_setting ORDER BY key`).toEqual([
      { key: "smtp.host", value: "mail.example.test" },
    ]);
    const rows = await fixture.sql<
      {
        key: string;
        ciphertext: string;
        iv: string;
        tag: string;
        updated_by_user_id: string | null;
      }[]
    >`SELECT key, ciphertext, iv, tag, updated_by_user_id FROM system_secret`;
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.key).toBe("smtp.password");
    expect(row?.updated_by_user_id).toBeNull();
    expect(JSON.stringify(row)).not.toContain(SMTP_PASSWORD);
    expect(Buffer.from(row?.ciphertext ?? "", "base64").toString("utf8")).not.toContain(
      SMTP_PASSWORD,
    );
  });

  it("returns the stored value through the loader and reports it only as configured", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtp.password", value: SMTP_PASSWORD },
        { key: "maptiler.apiKey", value: MAPTILER_KEY },
      ],
      null,
      fixture.db,
    );

    expect(await secretValues(settings, ALL_SECRETS, fixture.db)).toEqual({
      "smtp.password": SMTP_PASSWORD,
      "maptiler.apiKey": MAPTILER_KEY,
    });
    const groups = await settings.settingsView(fixture.db);
    const smtp = groups.flatMap((group) => group.settings).find((s) => s.key === "smtp.password");
    expect(smtp).toMatchObject({ value: "***", source: "database", secret: true });
    expect(JSON.stringify(groups)).not.toContain(SMTP_PASSWORD);
  });

  it("lets an environment override take precedence over the stored secret", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
      fixture.db,
    );
    vi.stubEnv("SMTP_PASSWORD", "from-the-environment");
    const groups = await settings.settingsView(fixture.db);
    expect(
      groups.flatMap((group) => group.settings).find((s) => s.key === "smtp.password"),
    ).toMatchObject({ value: "***", source: "env", envOverride: true });
  });

  it("removes a secret setting saved as empty", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
      fixture.db,
    );
    await settings.saveSystemSettings([{ key: "smtp.password", value: "" }], null, fixture.db);
    expect(await fixture.sql`SELECT key FROM system_secret`).toEqual([]);
    expect(await fixture.sql`SELECT key FROM system_setting`).toEqual([]);
    expect(await secretValues(settings, ALL_SECRETS, fixture.db)).toEqual({});
  });

  it("attributes the change to the administrator and forgets them when the account goes", async () => {
    await fixture.sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('secret-admin', 'Secret admin', 'secret-admin@example.test', true, now(), now())`;
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      "secret-admin",
      fixture.db,
    );
    expect(await fixture.sql`SELECT updated_by_user_id FROM system_secret`).toEqual([
      { updated_by_user_id: "secret-admin" },
    ]);
    await fixture.sql`DELETE FROM "user" WHERE id = 'secret-admin'`;
    expect(await fixture.sql`SELECT updated_by_user_id FROM system_secret`).toEqual([
      { updated_by_user_id: null },
    ]);
  });

  it("returns the value after an API restart with the same key file", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
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
      expect(await secretValues(restarted, ALL_SECRETS, restartedDb)).toEqual({
        "smtp.password": SMTP_PASSWORD,
      });
    } finally {
      vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
      // Later imports must not reuse the module graph bound to this connection.
      vi.resetModules();
      await connection.end({ timeout: 2 });
    }
  });

  it("keeps the plaintext out of a pg_dump of the table", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
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
    expect(dump.output).toContain("'smtp.password'");
    expect(dump.output).not.toContain(SMTP_PASSWORD);
  });

  it("refuses to save or read a secret without a key, saying how to get one", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
      fixture.db,
    );
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", join(keys, "absent"));
    await expect(secretValues(settings, ALL_SECRETS, fixture.db)).rejects.toThrow(
      /smtp\.password cannot be read: Secrets key file is missing or unreadable \(OPENMAPX_SECRETS_KEY_FILE\)\..*run `pnpm openmapx compose render`/,
    );
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/Secrets key file is missing or unreadable/);

    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/secrets key is not configured: run `pnpm openmapx compose render`/);
  });

  it("refuses a ciphertext copied into another setting's row", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtp.password", value: SMTP_PASSWORD },
        { key: "maptiler.apiKey", value: MAPTILER_KEY },
      ],
      null,
      fixture.db,
    );
    expect(await fixture.sql`SELECT key, key_version FROM system_secret ORDER BY key`).toEqual([
      { key: "maptiler.apiKey", key_version: 1 },
      { key: "smtp.password", key_version: 1 },
    ]);
    await fixture.sql`UPDATE system_secret AS target
      SET ciphertext = source.ciphertext, iv = source.iv, tag = source.tag
      FROM system_secret AS source
      WHERE target.key = 'maptiler.apiKey' AND source.key = 'smtp.password'`;
    await expect(secretValues(settings, ["maptiler.apiKey"], fixture.db)).rejects.toThrow(
      /maptiler\.apiKey cannot be read: A stored secret cannot be decrypted/,
    );
    await expect(secretValues(settings, ["smtp.password"], fixture.db)).resolves.toEqual({
      "smtp.password": SMTP_PASSWORD,
    });
  });

  it("refuses a value written with an unknown key version", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
      fixture.db,
    );
    await fixture.sql`UPDATE system_secret SET key_version = 2 WHERE key = 'smtp.password'`;
    await expect(secretValues(settings, ["smtp.password"], fixture.db)).rejects.toThrow(
      /smtp\.password cannot be read/,
    );
  });

  it("refuses a key that is not the one the value was saved with", async () => {
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
      fixture.db,
    );
    vi.stubEnv(
      "OPENMAPX_SECRETS_KEY_FILE",
      writeKey("other-key", randomBytes(32).toString("base64url")),
    );
    await expect(secretValues(settings, ALL_SECRETS, fixture.db)).rejects.toThrow(
      /smtp\.password cannot be read: A stored secret cannot be decrypted with the configured secrets key/,
    );
  });

  it("lets the environment supply a credential whose stored value the key cannot open", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtp.password", value: SMTP_PASSWORD },
        { key: "maptiler.apiKey", value: MAPTILER_KEY },
        { key: "smtp.host", value: "mail.example.test" },
      ],
      null,
      fixture.db,
    );
    // A restore onto a host with another key.
    vi.stubEnv(
      "OPENMAPX_SECRETS_KEY_FILE",
      writeKey("restored-host-key", randomBytes(32).toString("base64url")),
    );
    const { loadEmailConfig, getEmailDisclosure } = await import("../utils/email");

    // Without an override, the send fails with the reason.
    await expect(loadEmailConfig()).rejects.toThrow(
      /secret setting smtp\.password cannot be read: A stored secret cannot be decrypted/,
    );

    // With SMTP_PASSWORD set, the stored rows are not touched and mail works.
    vi.stubEnv("SMTP_PASSWORD", "from-the-environment");
    const config = await loadEmailConfig();
    expect(config.provider).toBe("smtp");
    expect(config.smtp).toMatchObject({ host: "mail.example.test", pass: "from-the-environment" });
    // The privacy disclosure needs only which provider is configured.
    await expect(getEmailDisclosure()).resolves.toBeDefined();
  });

  it("marks a stored secret in effect that the current key cannot open", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtp.password", value: SMTP_PASSWORD },
        { key: "maptiler.apiKey", value: MAPTILER_KEY },
      ],
      null,
      fixture.db,
    );
    const view = async () =>
      Object.fromEntries(
        (await settings.settingsView(fixture.db))
          .flatMap((group) => group.settings)
          .filter((s) => s.secret)
          .map((s) => [s.key, s]),
      );
    expect((await view())["smtp.password"]).not.toHaveProperty("unreadable");

    vi.stubEnv(
      "OPENMAPX_SECRETS_KEY_FILE",
      writeKey("unreadable-view-key", randomBytes(32).toString("base64url")),
    );
    vi.stubEnv("MAPTILER_API_KEY", "from-the-environment");
    const settingsView = await view();
    expect(settingsView["smtp.password"]).toMatchObject({
      value: "***",
      source: "database",
      unreadable: true,
    });
    // The environment's value is in effect, so the stored one does not matter.
    expect(settingsView["maptiler.apiKey"]).toMatchObject({ source: "env" });
    expect(settingsView["maptiler.apiKey"]).not.toHaveProperty("unreadable");
    expect(settingsView["lettermint.apiToken"]).not.toHaveProperty("unreadable");
  });

  it("reports a stored value the setting does not accept without blocking the editor", async () => {
    vi.stubEnv("RETENTION_AUDIT_LOG_DAYS", undefined);
    await fixture.sql`
      INSERT INTO system_setting (key, value) VALUES ('retention.auditLogDays', '0'::jsonb)`;

    expect([...(await settings.invalidStoredSettings(fixture.db))]).toEqual([
      "retention.auditLogDays",
    ]);
    await expect(
      settings.resolveSetting("retention.auditLogDays", { database: fixture.db }),
    ).rejects.toBeInstanceOf(settings.SettingValueError);
    const view = (await settings.settingsView(fixture.db))
      .flatMap((group) => group.settings)
      .find((s) => s.key === "retention.auditLogDays");
    expect(view).toMatchObject({ value: 365, source: "database", unreadable: true });

    await settings.saveSystemSettings(
      [{ key: "retention.auditLogDays", value: 90 }],
      null,
      fixture.db,
    );
    expect((await settings.invalidStoredSettings(fixture.db)).size).toBe(0);

    // The environment's value is in effect, so the stored one is not reported.
    await fixture.sql`
      UPDATE system_setting SET value = '0'::jsonb WHERE key = 'retention.auditLogDays'`;
    vi.stubEnv("RETENTION_AUDIT_LOG_DAYS", "30");
    expect((await settings.invalidStoredSettings(fixture.db)).size).toBe(0);
  });

  it("accepts the key file only exactly as the render writes it", async () => {
    const value = randomBytes(32).toString("base64url");
    const newline = writeKey("newline-key", `${value}\n`);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", newline);
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/Secrets key file has an invalid size.*with no newline/);
    const writable = join(keys, "writable-key");
    writeFileSync(writable, value, { mode: 0o644 });
    chmodSync(writable, 0o644);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writable);
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/Secrets key file must have mode 0444/);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writeKey("canonical-key", value));
    vi.stubEnv("OPENMAPX_SECRETS_KEY_UID", String((process.getuid?.() ?? 0) + 1));
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/Secrets key file has an invalid owner/);
  });

  it("refuses the former 64-character hex key format", async () => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writeKey("hex-key", randomBytes(32).toString("hex")));
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/43 base64url characters.*64-character hex format is not accepted/);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY", randomBytes(32).toString("hex"));
    await expect(
      settings.saveSystemSettings([{ key: "smtp.password", value: "new" }], null, fixture.db),
    ).rejects.toThrow(/OPENMAPX_SECRETS_KEY must hold 32 random bytes/);
  });

  it("accepts the same key in OPENMAPX_SECRETS_KEY for development but not beside the file", async () => {
    const value = randomBytes(32).toString("base64url");
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY", value);
    await settings.saveSystemSettings(
      [{ key: "smtp.password", value: SMTP_PASSWORD }],
      null,
      fixture.db,
    );
    vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writeKey("same-key", value));
    expect(await secretValues(settings, ALL_SECRETS, fixture.db)).toEqual({
      "smtp.password": SMTP_PASSWORD,
    });
    vi.stubEnv("OPENMAPX_SECRETS_KEY", value);
    await expect(secretValues(settings, ALL_SECRETS, fixture.db)).rejects.toThrow(
      /Set either OPENMAPX_SECRETS_KEY_FILE or OPENMAPX_SECRETS_KEY, not both/,
    );
  });
});
