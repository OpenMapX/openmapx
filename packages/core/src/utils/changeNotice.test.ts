import type { Licensing } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { requiresChangeNotice } from "./changeNotice";

const binding = (
  license: Licensing["bindings"][number]["license"],
  scope: Licensing["bindings"][number]["scope"] = "data",
) => ({ scope, subject: "Source", license });
const spdx = (expression: string) => binding({ kind: "spdx", expression });
/** OpenConditions captures its LicenseRef licences as custom ones under its namespace. */
const ref = (id: string) =>
  binding({ kind: "custom", id, namespace: "openconditions:licences", name: id });
const licensing = (...bindings: Licensing["bindings"]): Licensing => ({ version: 1, bindings });

describe("requiresChangeNotice", () => {
  it("follows each licence's own change-notice condition", () => {
    expect(requiresChangeNotice(licensing(spdx("CC-BY-4.0")))).toBe(true);
    expect(requiresChangeNotice(licensing(spdx("CC-BY-3.0-DE")))).toBe(true);
    expect(requiresChangeNotice(licensing(spdx("DL-DE-BY-2.0")))).toBe(true);
    expect(requiresChangeNotice(licensing(ref("LicenseRef-GeoNutzV")))).toBe(true);
    expect(requiresChangeNotice(licensing(spdx("DL-DE-ZERO-2.0")))).toBe(false);
    expect(requiresChangeNotice(licensing(spdx("ODbL-1.0")))).toBe(false);
    expect(requiresChangeNotice(licensing(spdx("CC0-1.0")))).toBe(false);
    expect(requiresChangeNotice(licensing(ref("LicenseRef-OGL-BC")))).toBe(false);
  });

  it("lets a choice of licences go without the notice only when one of them asks none", () => {
    expect(requiresChangeNotice(licensing(spdx("CC-BY-4.0 OR NLOD-2.0")))).toBe(true);
    expect(requiresChangeNotice(licensing(spdx("CC0-1.0 OR CC-BY-4.0")))).toBe(false);
    expect(requiresChangeNotice(licensing(spdx("CC0-1.0 AND CC-BY-4.0")))).toBe(true);
  });

  it("asks for the notice where it cannot tell", () => {
    expect(requiresChangeNotice(undefined)).toBe(true);
    expect(requiresChangeNotice(licensing())).toBe(true);
    expect(requiresChangeNotice(licensing(binding({ kind: "unknown" })))).toBe(true);
    expect(requiresChangeNotice(licensing(binding({ kind: "per-item" })))).toBe(true);
    expect(requiresChangeNotice(licensing(ref("LicenseRef-Unreviewed-Terms")))).toBe(true);
    // Only a software licence: nothing says what the data comes under.
    expect(requiresChangeNotice(licensing({ ...spdx("MIT"), scope: "software" }))).toBe(true);
  });

  it("reads only the data a credit covers, beside the software that serves it", () => {
    const softwareAndData = licensing({ ...spdx("MIT"), scope: "software" }, spdx("CC0-1.0"));
    expect(requiresChangeNotice(softwareAndData)).toBe(false);
    expect(
      requiresChangeNotice(licensing({ ...spdx("MIT"), scope: "software" }, spdx("CC-BY-4.0"))),
    ).toBe(true);
  });

  it("reads a custom licence by its id and public-domain material as asking none", () => {
    expect(requiresChangeNotice(licensing(ref("LicenseRef-TfL-Transport-Data-Service")))).toBe(
      false,
    );
    expect(requiresChangeNotice(licensing(ref("LicenseRef-Service-Terms")))).toBe(true);
    expect(
      requiresChangeNotice(
        licensing(binding({ kind: "public-domain", name: "U.S. Public Domain" })),
      ),
    ).toBe(false);
    expect(requiresChangeNotice(licensing(binding({ kind: "status", id: "CC-PDM-1.0" })))).toBe(
      false,
    );
  });
});
