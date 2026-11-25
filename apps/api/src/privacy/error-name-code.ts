const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/**
 * An error's name as an UPPER_SNAKE code (`TypeError` → `TYPE_ERROR`), for a
 * stored or reported failure that must not carry the message; `fallback` when
 * the error has no usable name.
 */
export function errorNameCode(error: unknown, fallback: string): string {
  const name = error instanceof Error ? error.name : "";
  const code = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 96)
    .replace(/_+$/, "");
  return UPPER_SNAKE.test(code) ? code : fallback;
}
