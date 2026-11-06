import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { adminApiOrigin, readAdminSessionFile } from "../src/lib/admin-session";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-admin-session-"));
  roots.push(root);
  const path = join(root, "session");
  writeFileSync(path, "__Secure-better-auth.session_token=synthetic.signed%3D\n", { mode: 0o600 });
  return { root, path };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("accepts only the session cookie from a private operator file", () => {
  const f = fixture();
  expect(readAdminSessionFile(f.path)).toBe(
    "__Secure-better-auth.session_token=synthetic.signed%3D",
  );
});
it.each(["readable", "hardlink", "symlink", "extra-cookie", "newline", "oversized"])(
  "refuses %s without disclosing content",
  (kind) => {
    const f = fixture();
    if (kind === "readable") chmodSync(f.path, 0o644);
    if (kind === "hardlink") linkSync(f.path, join(f.root, "copy"));
    if (kind === "symlink") {
      symlinkSync(f.path, join(f.root, "link"));
      f.path = join(f.root, "link");
    }
    if (kind === "extra-cookie")
      writeFileSync(f.path, "better-auth.session_token=secret; other=private");
    if (kind === "newline")
      writeFileSync(f.path, "better-auth.session_token=secret\nX-Private: value");
    if (kind === "oversized") writeFileSync(f.path, "x".repeat(16385));
    expect(() => readAdminSessionFile(f.path)).toThrow(/session file/i);
  },
);
it("binds to an HTTPS origin, permitting HTTP only for explicit loopback development", () => {
  expect(adminApiOrigin(undefined, "maps.example.test")).toBe("https://maps.example.test");
  expect(() => adminApiOrigin("http://maps.example.test")).toThrow();
  expect(() => adminApiOrigin("https://user:secret@maps.example.test")).toThrow();
  expect(() => adminApiOrigin("https://maps.example.test/path")).toThrow();
  expect(() => adminApiOrigin("http://127.0.0.1:3001")).toThrow();
  expect(adminApiOrigin("http://127.0.0.1:3001", undefined, true)).toBe("http://127.0.0.1:3001");
});
