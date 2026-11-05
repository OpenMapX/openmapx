/** Browser display retention, independent of the remote log-reader lifetime. */
export const MAX_SERVICE_LOG_BYTES = 256 * 1024;
export const MAX_SERVICE_LOG_LINES = 1000;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function tail(text: string, maximum: number) {
  // Bound temporary encoding even if a transport supplies one enormous chunk.
  let value = text.length > maximum ? text.slice(-maximum) : text;
  if (/^[\uDC00-\uDFFF]/.test(value)) value = value.slice(1);
  const bytes = encoder.encode(value);
  if (bytes.length <= maximum) return value;
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}
export class BoundedServiceLogBuffer {
  private rows: { text: string; bytes: number }[] = [];
  private partial = "";
  private bytes = 0;
  private truncated = false;
  append(chunk: string) {
    const bounded = tail(chunk, MAX_SERVICE_LOG_BYTES);
    if (bounded !== chunk) {
      this.truncated = true;
      this.partial = "";
    }
    let parts = (this.partial + bounded).split("\n");
    const last = parts.pop() ?? "";
    this.partial = tail(last, MAX_SERVICE_LOG_BYTES - 1);
    if (this.partial !== last) this.truncated = true;
    if (parts.length > MAX_SERVICE_LOG_LINES) {
      parts = parts.slice(-MAX_SERVICE_LOG_LINES);
      this.rows = [];
      this.bytes = 0;
      this.truncated = true;
    }
    for (const part of parts) {
      const text = tail(part.replace(/\r$/, ""), MAX_SERVICE_LOG_BYTES - 1);
      if (text !== part.replace(/\r$/, "")) this.truncated = true;
      const bytes = encoder.encode(text).length + 1;
      this.rows.push({ text, bytes });
      this.bytes += bytes;
    }
    // Partial output counts towards both the line and byte budget.
    const partialBytes = encoder.encode(this.partial).length;
    let remove = 0;
    while (
      this.rows.length - remove + (this.partial ? 1 : 0) > MAX_SERVICE_LOG_LINES ||
      this.bytes + partialBytes > MAX_SERVICE_LOG_BYTES
    ) {
      const row = this.rows[remove++];
      if (!row) break;
      this.bytes -= row.bytes;
      this.truncated = true;
    }
    if (remove) this.rows.splice(0, remove);
  }
  finish() {
    if (this.partial) this.append("\n");
  }
  snapshot() {
    return {
      lines: [...this.rows.map((row) => row.text), ...(this.partial ? [this.partial] : [])],
      truncated: this.truncated,
    };
  }
}
