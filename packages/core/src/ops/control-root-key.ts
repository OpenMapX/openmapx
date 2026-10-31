/** Browser-safe format only. A timed key restricts validity; it grants no authority. */
export interface ControlExecutionOrigin {
  version: 1;
  rootKey: string;
  issuer: "ops-agent" | "data-manager" | "host-cli";
  notAfter: number;
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function createControlRootOperationKey(input: {
  notAfter: number;
  nonce: Uint8Array;
}): string {
  if (
    !Number.isSafeInteger(input.notAfter) ||
    input.notAfter <= 0 ||
    !(input.nonce instanceof Uint8Array) ||
    input.nonce.byteLength !== 16
  )
    throw Error("Invalid control root expiry or nonce");
  return `opk1_t1_${input.notAfter.toString(16).padStart(14, "0")}_${encode(input.nonce)}`;
}
export function parseControlRootOperationKey(key: string): { notAfter: number; nonce: string } {
  const match = /^opk1_t1_([0-9a-f]{14})_([A-Za-z0-9_-]{22})$/.exec(key);
  if (!match?.[1] || !match[2])
    throw Error("Unsupported control root key; upgrade the control producer");
  const notAfter = Number.parseInt(match[1], 16);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[2].replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw Error("Noncanonical control root nonce");
  }
  if (createControlRootOperationKey({ notAfter, nonce: bytes }) !== key)
    throw Error("Noncanonical control root key");
  return { notAfter, nonce: match[2] };
}
