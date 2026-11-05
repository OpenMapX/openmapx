import { stripVTControlCharacters } from "node:util";
import { scrubSecrets } from "@openmapx/core/scrub-secrets";
/** Operator-safe status text. Rich worker artifacts stay in their trusted store. */
export function dataExecutionDiagnostic(value: string): { message: string; truncated: boolean } {
  const safe = scrubSecrets(stripVTControlCharacters(value))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove C0/C1 diagnostic controls.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/(^|[\s("'=])\/(?:[^\s"'<>]+)/g, "$1[host-path]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[host-path]");
  let message = "",
    bytes = 0;
  for (const character of safe) {
    const width = Buffer.byteLength(character);
    if (bytes + width > 4096) break;
    message += character;
    bytes += width;
  }
  return { message, truncated: message.length < safe.length };
}
