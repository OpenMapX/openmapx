import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const { credentialRefusal, freshSignInHref, FreshSignInPrompt, safeReturnPath } = await import(
  "./freshSignIn"
);

describe("credentialRefusal", () => {
  it("maps the API's account-security codes", () => {
    expect(credentialRefusal({ code: "FRESH_SIGN_IN_REQUIRED", status: 401 })).toBe("sign-in");
    expect(credentialRefusal({ code: "IMPERSONATION_NOT_ALLOWED", status: 403 })).toBe(
      "impersonating",
    );
  });

  it("reads the code from a thrown error that carries the API body", () => {
    expect(credentialRefusal({ body: { code: "FRESH_SIGN_IN_REQUIRED" } })).toBe("sign-in");
  });

  it.each([null, undefined, "FRESH_SIGN_IN_REQUIRED", { code: "INVALID_OTP" }, { status: 401 }])(
    "leaves any other error (%j) to the caller",
    (error) => {
      expect(credentialRefusal(error)).toBeNull();
    },
  );
});

describe("safeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/delete-account", "/delete-account"],
    ["/?place=osm%3Anode%3A12&tab=overview", "/?place=osm%3Anode%3A12&tab=overview"],
  ])("keeps the same-site path %s", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });

  it.each([
    null,
    "",
    "delete-account",
    "//evil.example/steal",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/\tevil",
    `/${"a".repeat(2048)}`,
  ])("falls back to / for %j", (value) => {
    expect(safeReturnPath(value)).toBe("/");
  });
});

describe("FreshSignInPrompt", () => {
  it("links to the sign-in page with the return path", () => {
    render(<FreshSignInPrompt returnPath="/delete-account" />);

    expect(screen.getByText("account.freshSignIn.notice")).not.toBeNull();
    const link = screen.getByText("account.freshSignIn.signInAgain").closest("a");
    expect(link?.getAttribute("href")).toBe("/auth/confirm?return=%2Fdelete-account");
  });

  it("never links to an off-site return target", () => {
    expect(freshSignInHref("//evil.example")).toBe("/auth/confirm?return=%2F");
  });
});
