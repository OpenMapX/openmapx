import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));

const {
  PLATFORM_CONFIGURATION_SETTING,
  SECRET_SETTING_KEYS,
  SETTING_DEFS,
  STORED_SETTING_KEYS,
  settingEnvName,
} = await import("../setting-defs");
const { assertSettingsEnvironment, settingEnvVar } = await import("../settings");

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const API_SOURCE = join(REPO_ROOT, "apps/api/src");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === "__tests__" || name === "test" || name === "db" ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("setting keys", () => {
  it("are dotted lowerCamel segments", () => {
    for (const def of SETTING_DEFS)
      expect(def.key).toMatch(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/);
    expect(PLATFORM_CONFIGURATION_SETTING).toMatch(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/);
    expect(new Set(SETTING_DEFS.map((def) => def.key)).size).toBe(SETTING_DEFS.length);
  });

  it("derive their environment variable mechanically", () => {
    expect(settingEnvName("email.fromAddress")).toBe("EMAIL_FROM_ADDRESS");
    expect(settingEnvName("retention.auditLogDays")).toBe("RETENTION_AUDIT_LOG_DAYS");
    expect(settingEnvName("legal.controller.postalCode")).toBe("LEGAL_CONTROLLER_POSTAL_CODE");
    expect(settingEnvName("smtp.password")).toBe("SMTP_PASSWORD");
    expect(settingEnvName("dataUse.allowNonCommercial")).toBe("DATA_USE_ALLOW_NON_COMMERCIAL");
  });

  it("split stored and secret keys for the table constraints", () => {
    expect(STORED_SETTING_KEYS).toContain(PLATFORM_CONFIGURATION_SETTING);
    expect(STORED_SETTING_KEYS).not.toContain("retention.backupDays");
    expect(STORED_SETTING_KEYS.some((key) => SECRET_SETTING_KEYS.includes(key))).toBe(false);
  });

  it("each have a reader outside the settings modules", () => {
    const settingsModules = new Set([
      join(API_SOURCE, "services/settings.ts"),
      join(API_SOURCE, "services/setting-defs.ts"),
    ]);
    const sources = sourceFiles(API_SOURCE)
      .filter((path) => !settingsModules.has(path))
      .map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") }));
    const unread = SETTING_DEFS.map((def) => def.key).filter(
      (key) => !sources.some(({ text }) => text.includes(`"${key}"`)),
    );
    expect(unread).toEqual([]);
  });
});

describe("environment variables of settings", () => {
  const envSettings = SETTING_DEFS.filter((def) => settingEnvVar(def) !== undefined);

  it("reach the API container and are documented", () => {
    const manifest = JSON.parse(read("services/api/service.json")) as {
      container: { environment: Record<string, string> };
    };
    const environment = manifest.container.environment;
    const example = read("infra/docker/.env.example");
    const docs = read("docs/docs/install/configuration.md");
    for (const def of envSettings) {
      const name = settingEnvVar(def) as string;
      expect(environment[name], name).toBeDefined();
      expect(example, name).toMatch(new RegExp(`^#? ?${name}=`, "m"));
      expect(docs, name).toContain(`\`${name}\``);
    }
  });

  it("treat an empty value as unset and accept exactly true, false, 1 and 0", () => {
    vi.stubEnv("SMTP_SECURITY", "");
    vi.stubEnv("DATA_USE_ALLOW_GREY_AREA", "0");
    vi.stubEnv("AUTH_EMAIL_VERIFICATION_REQUIRED", "true");
    expect(() => assertSettingsEnvironment()).not.toThrow();
    vi.stubEnv("DATA_USE_ALLOW_GREY_AREA", "yes");
    expect(() => assertSettingsEnvironment()).toThrow(/DATA_USE_ALLOW_GREY_AREA/);
  });

  it("refuse every invalid value at once, naming each variable", () => {
    vi.stubEnv("RETENTION_PRIVACY_CASE_DAYS", "14");
    vi.stubEnv("SMTP_PORT", "0x19");
    vi.stubEnv("LEGAL_CONTROLLER_EMAIL", "not an address");
    let message = "";
    try {
      assertSettingsEnvironment();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("RETENTION_PRIVACY_CASE_DAYS");
    expect(message).toContain("SMTP_PORT");
    expect(message).toContain("LEGAL_CONTROLLER_EMAIL");
  });
});
