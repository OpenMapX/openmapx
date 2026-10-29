/** Resolve transport only. Query keys and lifetime owners retain raw configured identity.
 * Client components may render on the server; no browser request runs there.
 */
export function browserAdminApiBase(
  apiUrl: string,
  documentOrigin = typeof document === "undefined" ? undefined : document.location.origin,
): string {
  if (!apiUrl) return documentOrigin ?? "";
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Admin API URL must be an HTTP origin");
  return url.origin;
}
