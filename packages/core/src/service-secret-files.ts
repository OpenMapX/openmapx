import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_SECRET_BYTES = 4_096;

/**
 * Read a secret that `openmapx compose render` wrote to a file and the
 * deployment mounts into the container. The file must be a regular file, not a
 * link, and hold the secret alone; one trailing newline is tolerated so an
 * operator may write it with an editor.
 */
export function readServiceSecretFile(path: string, label: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error(`${label} file is missing or unreadable`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${label} file must be a regular file`);
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read > MAX_SECRET_BYTES) throw new Error(`${label} file exceeds the size limit`);
    const value = bytes
      .subarray(0, read)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    if (value.trim() === "" || value !== value.trim())
      throw new Error(`${label} file must hold the secret alone`);
    return value;
  } finally {
    closeSync(fd);
  }
}

/**
 * The database connection string a service uses. `DATABASE_URL` names the
 * server, database and role; `DATABASE_PASSWORD_FILE`, when set, supplies the
 * role's password, so the password never sits in the environment. A URL that
 * already carries a password together with a password file is refused: the two
 * would disagree about which credential applies.
 */
export function resolveDatabaseUrl(
  fallback: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.DATABASE_URL?.trim() || fallback;
  const passwordFile = env.DATABASE_PASSWORD_FILE?.trim();
  if (!passwordFile) return configured;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }
  if (url.password) throw new Error("DATABASE_URL must not carry a password with a password file");
  if (!url.username) throw new Error("DATABASE_URL must name the role a password file belongs to");
  url.password = encodeURIComponent(readServiceSecretFile(passwordFile, "Database password"));
  return url.toString();
}
