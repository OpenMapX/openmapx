import { describe, expect, it } from "vitest";
import {
  backupOmissionAcceptanceSchema,
  backupWarningsDigest,
  listBackupWarningReviews,
} from "./backup-omission-review.js";

describe("backup omission review", () => {
  it("binds the immutable review, manifest, and canonical warning set", () => {
    const left = backupWarningsDigest({
      backupReviewId: "review-1",
      manifestDigest: "a".repeat(64),
      warningCodes: ["storage-missing", "schema-missing", "storage-missing"],
    });
    const right = backupWarningsDigest({
      backupReviewId: "review-1",
      manifestDigest: "a".repeat(64),
      warningCodes: ["schema-missing", "storage-missing"],
    });
    expect(left).toEqual(right);
    expect(left.warningCodes).toEqual(["schema-missing", "storage-missing"]);
    expect(
      backupWarningsDigest({
        backupReviewId: "review-2",
        manifestDigest: "a".repeat(64),
        warningCodes: right.warningCodes,
      }).warningsDigest,
    ).not.toBe(left.warningsDigest);
  });

  it("accepts only a concrete digest and bounded reason", () => {
    expect(
      backupOmissionAcceptanceSchema.parse({
        warningsDigest: "b".repeat(64),
        reasonCode: "verified-source-absence",
        requestVersion: 3,
      }),
    ).toBeTruthy();
    expect(() =>
      backupOmissionAcceptanceSchema.parse({
        warningsDigest: "pending",
        reasonCode: "ok",
        requestVersion: 3,
      }),
    ).toThrow();
  });

  it("matches acceptance only to the exact detected digest", async () => {
    const detected = {
      backupReviewId: "review-1",
      manifestDigest: "a".repeat(64),
      warningCodes: ["one"],
    };
    const detectedDigest = backupWarningsDigest(detected).warningsDigest;
    const database = {
      select() {
        const chain = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          orderBy() {
            return Promise.resolve([
              {
                eventType: "backup_extraction_warnings_detected",
                payload: {
                  ...detected,
                  warningsDigest: detectedDigest,
                },
              },
              {
                eventType: "backup_extraction_warnings_accepted",
                payload: {
                  ...detected,
                  warningsDigest: detectedDigest,
                  reasonCode: "verified-source-absence",
                  operationDigest: "2".repeat(64),
                },
              },
            ]);
          },
        };
        return chain;
      },
    };
    await expect(listBackupWarningReviews("request-1", database as never)).resolves.toEqual([
      expect.objectContaining({ warningsDigest: detectedDigest, accepted: true }),
    ]);
  });
});
