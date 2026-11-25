// @vitest-environment jsdom

import type { PublicLegalConfig } from "@openmapx/core/server-api";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyContentDe from "./content.de";
import PrivacyContentEn from "./content.en";

const legal: PublicLegalConfig = {
  name: "Example Maps GmbH",
  street: "Map Street 1",
  postalCode: "10115",
  city: "Berlin",
  country: "Germany",
  email: "legal@example.test",
  phone: "",
  hostingProvider: "",
  hostingLocations: "",
  supervisoryAuthority: "",
  supervisoryAuthorityUrl: "",
  serverLogRetentionDays: 30,
  dataRequestEmail: "requests@example.test",
  dsarCaseRetentionDays: 1095,
  deploymentJurisdiction: "DE-BE",
  privacySources: [],
  backupRetentionDays: 14,
  auditLogRetentionDays: 730,
};

function backupStatement(container: HTMLElement, heading: string): string {
  const item = [...container.querySelectorAll("li")].find((element) =>
    element.querySelector("strong")?.textContent?.startsWith(heading),
  );
  return item?.textContent ?? "";
}

describe("privacy page backup statement", () => {
  it("states the configured retention, recovery-only use, journal replay and the contact", () => {
    const { container } = render(<PrivacyContentEn legal={legal} />);
    const statement = backupStatement(container, "Backups");
    expect(statement).toContain("up to 14 days");
    expect(statement).toContain("only to recover from failure");
    expect(statement).toContain("may remain in backups until they expire");
    expect(statement).toContain("erasure journal");
    expect(statement).toContain("requests@example.test");
  });

  it("states the periods the API's retention enforces in both languages", () => {
    const en = render(<PrivacyContentEn legal={legal} />).container;
    expect(backupStatement(en, "Sessions, sign-in confirmations")).toContain(
      "deleted 30 days after they expire",
    );
    expect(backupStatement(en, "Share links")).toContain("deleted 30 days after it expires");
    expect(backupStatement(en, "Receipts of administrative changes")).toContain(
      "one year after the change",
    );
    expect(backupStatement(en, "Records of disclosures")).toContain("three years");
    const de = render(<PrivacyContentDe legal={legal} />).container;
    expect(backupStatement(de, "Sitzungen, Anmeldebestätigungen")).toContain(
      "30 Tage nach ihrem Ablauf gelöscht",
    );
    expect(backupStatement(de, "Freigabelinks")).toContain("30 Tage nach seinem Ablauf");
    expect(backupStatement(de, "Belege administrativer Änderungen")).toContain(
      "ein Jahr nach der Änderung",
    );
    expect(backupStatement(de, "Aufzeichnungen über Offenlegungen")).toContain("drei Jahre");
  });

  it("states the configured administrator activity-log retention", () => {
    const en = render(<PrivacyContentEn legal={legal} />).container;
    expect(backupStatement(en, "Administrator activity log")).toContain("deleted after 730 days.");
    const de = render(<PrivacyContentDe legal={legal} />).container;
    expect(backupStatement(de, "Protokoll administrativer Tätigkeiten")).toContain(
      "nach 730 Tagen gelöscht",
    );
  });

  it("describes traffic and hazard reports and their 12-month retention in both languages", () => {
    const en = render(<PrivacyContentEn legal={legal} />).container;
    expect(en.textContent).toContain("8. Traffic and Hazard Reports");
    expect(en.textContent).toContain("never connected to your OpenMapX account");
    expect(backupStatement(en, "Traffic and hazard reports")).toContain("12 months");
    const de = render(<PrivacyContentDe legal={legal} />).container;
    expect(de.textContent).toContain("8. Verkehrs- und Gefahrenmeldungen");
    expect(backupStatement(de, "Verkehrs- und Gefahrenmeldungen")).toContain("12 Monate");
  });

  it("renders the same facts in German", () => {
    const { container } = render(<PrivacyContentDe legal={legal} />);
    const statement = backupStatement(container, "Sicherungskopien");
    expect(statement).toContain("bis zu 14 Tage");
    expect(statement).toContain("Wiederherstellung nach einem Ausfall");
    expect(statement).toContain("Löschjournal");
    expect(statement).toContain("requests@example.test");
  });
});
