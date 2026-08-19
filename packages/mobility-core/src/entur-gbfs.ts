const ENTUR_GBFS_HOSTNAME = "api.entur.io";
const ENTUR_GBFS_PATH_PREFIX = "/mobility/v2/gbfs/";

/** Recognise an Entur-hosted GBFS discovery URL without matching lookalike hosts. */
export function isEnturGbfsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === ENTUR_GBFS_HOSTNAME && parsed.pathname.startsWith(ENTUR_GBFS_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}
