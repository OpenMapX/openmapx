import type { DeepLinkConfig } from "../../links/deepLinkIntent";
/** An external request can only show a confirmation. It can never stop a session. */
export function parseSurfaceAction(raw: string, config: DeepLinkConfig): string | null {
  if (raw.length > 1024) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== `${config.scheme.toLowerCase()}:` ||
      url.username ||
      url.password ||
      url.hash ||
      url.host ||
      url.pathname !== "/navigation/end"
    )
      return null;
    if ([...url.searchParams.keys()].some((k) => k !== "sessionId")) return null;
    const ids = url.searchParams.getAll("sessionId");
    const [id] = ids;
    return ids.length === 1 && id !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
