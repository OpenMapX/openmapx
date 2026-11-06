import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

/** Operator-owned credentials and receipts; never discovers browser stores. */
export function readPrivateOperatorFile(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = fstatSync(fd);
    if (
      !a.isFile() ||
      a.nlink !== 1 ||
      a.uid !== process.geteuid?.() ||
      (a.mode & 0o077) !== 0 ||
      a.size < 1 ||
      a.size > maximum
    )
      throw Error("Unsafe private file");
    const bytes = Buffer.alloc(a.size);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) throw Error("Private file changed");
      used += count;
    }
    const b = fstatSync(fd),
      named = lstatSync(path);
    if (
      a.dev !== b.dev ||
      a.ino !== b.ino ||
      a.size !== b.size ||
      a.mtimeMs !== b.mtimeMs ||
      a.ctimeMs !== b.ctimeMs ||
      b.ino !== named.ino ||
      b.dev !== named.dev ||
      named.isSymbolicLink()
    )
      throw Error("Private file changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}
export function readAdminSessionFile(path: string): string {
  try {
    const cookie = readPrivateOperatorFile(path, 16 * 1024).trim();
    if (!/^(?:__Secure-)?better-auth\.session_token=[A-Za-z0-9._~%+/=-]{1,16000}$/.test(cookie))
      throw Error("Invalid cookie");
    return cookie;
  } catch {
    throw Error(
      "Admin session file must contain only a Better Auth session cookie, owned by this user, mode 0600 and one link",
    );
  }
}
export function adminApiOrigin(input?: string, domain?: string, allowLoopbackHttp = false): string {
  const url = new URL(input ?? `https://${domain ?? ""}`);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        allowLoopbackHttp &&
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw Error("Use an HTTPS API origin without credentials, path or query");
  return url.origin;
}
