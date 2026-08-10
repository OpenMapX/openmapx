import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockDecrypt = vi.fn();

vi.mock("../../db/index.js", () => ({ db: { select: (..._args: unknown[]) => mockSelect() } }));
vi.mock("../secrets.js", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  encrypt: vi.fn(),
  isSecretsConfigured: vi.fn(() => true),
}));

import { getServiceSecretStrict } from "../service-secrets.js";

describe("getServiceSecretStrict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it("returns the decrypted secret when the exact row exists", async () => {
    mockLimit.mockResolvedValueOnce([{ ciphertext: "cipher", iv: "iv", tag: "tag" }]);
    mockDecrypt.mockReturnValueOnce("plain");

    await expect(getServiceSecretStrict("dawarich-app", "OIDC_CLIENT_SECRET")).resolves.toBe(
      "plain",
    );
    expect(mockDecrypt).toHaveBeenCalledWith("cipher", "iv", "tag");
  });

  it("returns null only when the row is absent", async () => {
    mockLimit.mockResolvedValueOnce([]);
    await expect(getServiceSecretStrict("dawarich-app", "OIDC_CLIENT_SECRET")).resolves.toBeNull();
  });

  it("propagates database and decryption failures instead of treating them as missing", async () => {
    mockLimit.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getServiceSecretStrict("dawarich-app", "OIDC_CLIENT_SECRET")).rejects.toThrow(
      "database unavailable",
    );

    mockLimit.mockResolvedValueOnce([{ ciphertext: "cipher", iv: "iv", tag: "tag" }]);
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error("decrypt failed");
    });
    await expect(getServiceSecretStrict("dawarich-app", "OIDC_CLIENT_SECRET")).rejects.toThrow(
      "decrypt failed",
    );
  });
});
