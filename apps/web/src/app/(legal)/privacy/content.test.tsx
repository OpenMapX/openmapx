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

  it("states the default and operator configuration when the API is unavailable", () => {
    const { container } = render(<PrivacyContentEn legal={null} />);
    expect(backupStatement(container, "Backups")).toContain(
      "the backup retention period the operator configures (30 days by default)",
    );
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
