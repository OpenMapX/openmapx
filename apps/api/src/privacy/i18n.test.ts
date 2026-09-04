import { locales, messages } from "@openmapx/i18n";
import { describe, expect, it } from "vitest";
import { type PrivacyNotificationTemplate, privacyRequestEmail } from "../utils/emailTemplates";
import { renderReadmeHtml } from "./archive-assembler";
import { createSubjectRequestSchema } from "./request-contracts";

describe("privacy translations", () => {
  it("renders every registered locale and notification template from the shared catalogue", () => {
    for (const locale of locales) {
      expect(renderReadmeHtml(locale)).toContain(messages[locale].privacyExport.readme.title);
      for (const template of Object.keys(
        messages[locale].privacyExport.email.templates,
      ) as PrivacyNotificationTemplate[]) {
        const mail = privacyRequestEmail(template, locale);
        expect(mail.subject).toContain(
          messages[locale].privacyExport.email.templates[template].subject,
        );
        expect(mail.html).toContain(`lang="${locale}"`);
      }
    }
  });
  it("accepts language tags with scripts and regions for future catalogues", () => {
    for (const locale of ["zh-Hant-TW", "pt-BR", "fil", "de-AT", "en-US-u-ca-gregory"]) {
      expect(createSubjectRequestSchema.parse({ userId: "user", locale }).locale).toBe(locale);
    }
    expect(createSubjectRequestSchema.safeParse({ userId: "user", locale: "en--US" }).success).toBe(
      false,
    );
  });
  it("resolves regional locales consistently for exports and notifications", () => {
    expect(renderReadmeHtml("de-AT")).toContain('<html lang="de">');
    expect(renderReadmeHtml("de-AT")).toContain("OpenMapX-Datenauskunft");
    expect(privacyRequestEmail("ready", "de-AT").subject).toContain("Ihre Datenauskunft");
  });
  it("localizes the whole German email including its layout and footers", () => {
    const mail = privacyRequestEmail("ready", "de");
    expect(mail.text).not.toContain("Open your");
    expect(mail.text).not.toContain("If you did not");
    expect(mail.html).toContain('<html lang="de">');
    expect(mail.html).not.toContain("You received this email");
    expect(mail.html).not.toContain("If you didn't request");
  });
  it("uses a safe default for unsupported or malformed locales", () => {
    expect(renderReadmeHtml('"><script>')).toContain('<html lang="en">');
    expect(renderReadmeHtml('"><script>')).not.toContain("<script>");
    expect(privacyRequestEmail("ready", "unknown")).toEqual(privacyRequestEmail("ready", "en"));
  });
});
