import { locales } from "@openmapx/i18n";
import { describe, expect, it } from "vitest";
import { SUBJECT_DATA_CATALOGUE, subjectDataCatalogue } from "./catalogue";
import { catalogueCopy } from "./catalogue-copy";

describe("OpenMapX subject-data catalogue", () => {
  const registration = (id: string) => {
    const value = SUBJECT_DATA_CATALOGUE.find((item) => item.id === id);
    if (!value) throw new Error(`Missing test catalogue registration: ${id}`);
    return value;
  };
  it("has unique strict registrations and locale parity", () => {
    expect(new Set(SUBJECT_DATA_CATALOGUE.map((item) => item.id)).size).toBe(
      SUBJECT_DATA_CATALOGUE.length,
    );
    for (const locale of locales) {
      expect(Object.keys(catalogueCopy[locale]).sort()).toEqual(
        SUBJECT_DATA_CATALOGUE.map((item) => item.id).sort(),
      );
    }
  });

  it("registers the account id kept until an extension has erased the account's data", () => {
    expect(registration("extension-erasure-pending")).toMatchObject({
      source: "openmapx-db",
      strategy: "operator_task",
      locators: [{ type: "user_id", field: "subject_erasure_pending.subject_user_id" }],
      legalBases: ["legal-obligation"],
      retention: { kind: "until-erased", reasonCode: "extension-erasure" },
    });
  });

  it("is the static catalogue while no integration declares registrations", () => {
    expect(subjectDataCatalogue()).toEqual(SUBJECT_DATA_CATALOGUE);
  });

  it("does not invent a deployment country for configurable controller and processor recipients", () => {
    for (const registration of SUBJECT_DATA_CATALOGUE) {
      for (const recipient of registration.recipients) {
        if (["openmapx-controller", "dawarich-managed"].includes(recipient.id))
          expect(recipient).not.toHaveProperty("country");
      }
    }
  });
});
