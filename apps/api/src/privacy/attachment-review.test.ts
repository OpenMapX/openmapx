import { ATTACHMENT_MAX_BYTES, privacyAttachmentUploadSchema } from "@openmapx/core/privacy";
import { describe, expect, it, vi } from "vitest";
import { createEncryptedAttachment } from "./attachments";

const upload = {
  version: 1,
  purpose: "identity_evidence",
  filename: "evidence.txt",
  mediaType: "text/plain",
  contentBase64: "aGVsbG8=",
};
describe("attachment bounded validation", () => {
  it("accepts the exact 25 MiB canonical base64 boundary without parser recursion", () => {
    const contentBase64 = Buffer.alloc(ATTACHMENT_MAX_BYTES, 65).toString("base64");
    expect(privacyAttachmentUploadSchema.safeParse({ ...upload, contentBase64 }).success).toBe(
      true,
    );
  });
  it.each([
    { contentBase64: "not*base64" },
    { contentBase64: "abcde" },
    { contentBase64: "a===" },
    { contentBase64: "aa=a" },
    { filename: "../evidence.txt" },
    { filename: "active.html" },
    { purpose: "operator_supplement" },
    { rightsReviewState: "approved" },
  ])("rejects invalid or caller-approved upload metadata (%j)", (change) => {
    expect(privacyAttachmentUploadSchema.safeParse({ ...upload, ...change }).success).toBe(false);
  });
  it("rejects decoded bound +1 and forged MIME before storage writes", async () => {
    const write = vi.fn();
    const input = {
      requestId: "synthetic",
      ownerId: "worker",
      purpose: "identity_evidence" as const,
      filename: "evidence.txt",
      mediaType: "text/plain" as const,
      expiresAt: new Date(Date.now() + 60000),
    };
    await expect(
      createEncryptedAttachment(
        { ...input, source: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 65) },
        { store: { write } as never, database: {} as never },
      ),
    ).rejects.toThrow("size limit");
    await expect(
      createEncryptedAttachment(
        { ...input, mediaType: "image/png", source: Buffer.from("not-a-png") },
        { store: { write } as never, database: {} as never },
      ),
    ).rejects.toThrow("signature");
    expect(write).not.toHaveBeenCalled();
  });
});
