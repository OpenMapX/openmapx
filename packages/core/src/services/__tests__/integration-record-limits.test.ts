import { INTEGRATION_ARCHIVE_LIMITS } from "@openmapx/extension-contracts/archive";
import { describe, expect, it } from "vitest";
import { MAX_RECORDED_FILES } from "../integration-records";

describe("integration record limits", () => {
  it("can record every file an archive at its per-kind limits holds", () => {
    // The declarative files an integration ships today beside its code: the
    // manifest, the artifact metadata, the licences file, up to 100 string
    // files, one preview and five legal files.
    const declarativeFiles = 1 + 1 + 1 + 100 + 1 + 5;
    const codeEntries = 2;
    const perKind =
      INTEGRATION_ARCHIVE_LIMITS.migrationFiles +
      INTEGRATION_ARCHIVE_LIMITS.messageFiles +
      INTEGRATION_ARCHIVE_LIMITS.assetFiles;
    expect(codeEntries + perKind + declarativeFiles).toBeLessThanOrEqual(MAX_RECORDED_FILES);
  });
});
