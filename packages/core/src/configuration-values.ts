/** Browser-safe validation shared by forms, the API and sealed configuration imports. */
export const OPERATOR_STRING_FORMATS = [
  "map-url",
  "map-tile-url",
  "ollama-duration",
  "photon-duration",
  "resource-region",
] as const;

export function parseOperatorUrl(value: unknown, template = false): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return undefined;
  if (value === "") return "";
  let address = value;
  if (template) address = address.replace(/\{[zxys]\}/g, "tile");
  if (/[{}]/.test(address)) return undefined;
  if (address.startsWith("/") && !address.startsWith("//")) return value;
  try {
    const url = new URL(address);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      /^https?:\/\//i.test(address)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function validOperatorString(value: string, format: string): boolean {
  if (format === "map-url" || format === "map-tile-url")
    return parseOperatorUrl(value, format === "map-tile-url") !== undefined;
  if (format === "resource-region")
    return (
      value.length <= 512 &&
      value !== "." &&
      !value.includes("..") &&
      /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/.test(value)
    );
  if (format === "ollama-duration" && value === "0") return true;
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(value);
  if (!match) return false;
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"];
  if (!Number.isFinite(seconds)) return false;
  if (format === "ollama-duration") return seconds > 0 && seconds <= 86400;
  // The pinned Photon parser accepts integer units, not fractional durations.
  if (format === "photon-duration")
    return !match[1].includes(".") && seconds >= 3600 && seconds <= 8760 * 3600;
  return false;
}

/** Only these built-in numeric controls support explicit reset to the manifest. */
export const SERVICE_RESOURCE_FIELDS = [
  "OPENMAPX_MEMORY_MIB",
  "OPENMAPX_CPU_LIMIT",
  "OPENMAPX_JAVA_HEAP_MIB",
] as const;
