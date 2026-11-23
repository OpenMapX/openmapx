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
  "emailLabsAppKey",
  "emailLabsSecretKey",
  "lettermintApiToken",
  "smtpPassword",
  "maptilerApiKey",
];

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

    expect(await settings.loadSecretSettings(ALL_SECRETS, fixture.db)).toEqual({
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
    expect(await settings.loadSecretSettings(ALL_SECRETS, fixture.db)).toEqual({});
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
      expect(await restarted.loadSecretSettings(ALL_SECRETS, restartedDb)).toEqual({
        smtpPassword: SMTP_PASSWORD,
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
    await expect(settings.loadSecretSettings(ALL_SECRETS, fixture.db)).rejects.toThrow(
      /smtpPassword cannot be read: Secrets key file is missing or unreadable \(OPENMAPX_SECRETS_KEY_FILE\)\..*run `pnpm openmapx compose render`/,
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
    await expect(settings.loadSecretSettings(ALL_SECRETS, fixture.db)).rejects.toThrow(
      /smtpPassword cannot be read: A stored secret cannot be decrypted with the configured secrets key/,
    );
  });

  it("lets the environment supply a credential whose stored value the key cannot open", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtpPassword", value: SMTP_PASSWORD },
        { key: "maptilerApiKey", value: MAPTILER_KEY },
        { key: "smtpHost", value: "mail.example.test" },
      ],
      "loopback",
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
      /secret setting smtpPassword cannot be read: A stored secret cannot be decrypted/,
    );

    // With SMTP_PASS set, the stored rows are not touched and mail works.
    vi.stubEnv("SMTP_PASS", "from-the-environment");
    const config = await loadEmailConfig();
    expect(config.provider).toBe("smtp");
    expect(config.smtp).toMatchObject({ host: "mail.example.test", pass: "from-the-environment" });
    // The privacy disclosure needs only which provider is configured.
    await expect(getEmailDisclosure()).resolves.toBeDefined();
  });

  it("marks a stored secret in effect that the current key cannot open", async () => {
    await settings.saveSystemSettings(
      [
        { key: "smtpPassword", value: SMTP_PASSWORD },
        { key: "maptilerApiKey", value: MAPTILER_KEY },
      ],
      "loopback",
      fixture.db,
    );
    const view = async () =>
      Object.fromEntries(
        (await settings.resolveSettings(fixture.db))
          .flatMap((group) => group.settings)
          .filter((s) => s.secret)
          .map((s) => [s.key, s]),
      );
    expect((await view()).smtpPassword).not.toHaveProperty("unreadable");

    vi.stubEnv(
      "OPENMAPX_SECRETS_KEY_FILE",
      writeKey("unreadable-view-key", randomBytes(32).toString("base64url")),
    );
    vi.stubEnv("MAPTILER_KEY", "from-the-environment");
    const settingsView = await view();
    expect(settingsView.smtpPassword).toMatchObject({
      value: "***",
      source: "database",
      unreadable: true,
    });
    // The environment's value is in effect, so the stored one does not matter.
    expect(settingsView.maptilerApiKey).toMatchObject({ source: "env" });
    expect(settingsView.maptilerApiKey).not.toHaveProperty("unreadable");
    expect(settingsView.lettermintApiToken).not.toHaveProperty("unreadable");
  });

  it("accepts the key file only exactly as the render writes it", async () => {
    const value = randomBytes(32).toString("base64url");
    const newline = writeKey("newline-key", `${value}\n`);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", newline);
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/Secrets key file has an invalid size.*with no newline/);
    const writable = join(keys, "writable-key");
    writeFileSync(writable, value, { mode: 0o644 });
    chmodSync(writable, 0o644);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writable);
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/Secrets key file must have mode 0444/);
    vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", writeKey("canonical-key", value));
    vi.stubEnv("OPENMAPX_SECRETS_KEY_UID", String((process.getuid?.() ?? 0) + 1));
    await expect(
      settings.saveSystemSettings([{ key: "smtpPassword", value: "new" }], "loopback", fixture.db),
    ).rejects.toThrow(/Secrets key file has an invalid owner/);
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
    expect(await settings.loadSecretSettings(ALL_SECRETS, fixture.db)).toEqual({
      smtpPassword: SMTP_PASSWORD,
    });
    vi.stubEnv("OPENMAPX_SECRETS_KEY", value);
    await expect(settings.loadSecretSettings(ALL_SECRETS, fixture.db)).rejects.toThrow(
      /Set either OPENMAPX_SECRETS_KEY_FILE or OPENMAPX_SECRETS_KEY, not both/,
    );
  });
});
