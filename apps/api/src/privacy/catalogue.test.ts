import { locales } from "@openmapx/i18n";
import { describe, expect, it } from "vitest";
import { catalogueAvailability, SUBJECT_DATA_CATALOGUE } from "./catalogue";
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

  it("distinguishes collector readiness from declaration", () => {
    expect(catalogueAvailability(registration("managed-dawarich"))).toBe("available");
    expect(catalogueAvailability(registration("backup-retained-copies"))).toBe("operator_review");
    expect(catalogueAvailability(registration("global-public-data"))).toBe("not_applicable");
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
