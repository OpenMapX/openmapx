/**
 * Throw a clear error if an admin-supplied config URL is set but is not a
 * syntactically valid http(s) URL. Allows localhost — a self-hosted MOTIS at
 * `http://localhost:8081` is the legitimate default — so this is a fail-fast
 * shape check, not a private-address SSRF guard.
 */
export function assertHttpUrlConfig(value: unknown, name: string): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    throw new Error(`geocoding-motis config "${name}" must be a string URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`geocoding-motis config "${name}" is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`geocoding-motis config "${name}" must use http(s): ${value}`);
  }
}
