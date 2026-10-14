export type RasterPayloadOpacity = "opaque" | "nonopaque" | "transparent" | "unknown";
/** JPEG has no alpha. Check the encoded format, not a URL or response header.
 * This evidence is usable ONLY after the engine successfully decodes/uploads
 * these same bytes. PNG is inspected separately by the bounded decoder below. */
export function rasterPayloadOpacity(data: ArrayBuffer): RasterPayloadOpacity {
  const b = new Uint8Array(data);
  if (!b.length) return "transparent";
  if (b[0] !== 255 || b[1] !== 216 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217)
    return "unknown";
  let frame = false;
  for (let i = 2; i + 3 < b.length; ) {
    if (b[i++] !== 255) return "unknown";
    while (b[i] === 255) i++;
    const marker = b[i++];
    const length = (b[i] << 8) | b[i + 1];
    if (length < 2 || i + length > b.length) return "unknown";
    if (marker === 192 || marker === 193 || marker === 194) {
      const channels = b[i + 7];
      frame =
        length === 8 + 3 * channels &&
        (channels === 1 || channels === 3 || channels === 4) &&
        b[i + 2] === 8 &&
        ((b[i + 3] << 8) | b[i + 4]) > 0 &&
        ((b[i + 5] << 8) | b[i + 6]) > 0;
    }
    if (marker === 218) return frame ? "opaque" : "unknown";
    i += length;
  }
  return "unknown";
}

/** Inspect PNG alpha from the SAME acquired bytes, without another request.
 * IHDR bounds the optional decode to 4M pixels; malformed/unsupported payloads
 * remain unknown. The native decoder/upload still owns the content commit. */
export async function inspectRasterPayloadOpacity(
  data: ArrayBuffer,
): Promise<RasterPayloadOpacity> {
  const encoded = rasterPayloadOpacity(data);
  if (encoded !== "unknown") return encoded;
  const b = new Uint8Array(data);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    b.length < 33 ||
    !signature.every((n, i) => b[i] === n) ||
    b[12] !== 73 ||
    b[13] !== 72 ||
    b[14] !== 68 ||
    b[15] !== 82 ||
    typeof createImageBitmap !== "function"
  )
    return "unknown";
  const view = new DataView(data);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4194304)
    return "unknown";
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: "image/png" }));
    if (bitmap.width !== width || bitmap.height !== height) return "unknown";
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "unknown";
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    let visible = false,
      opaque = true;
    for (let i = 3; i < pixels.length; i += 4) {
      visible ||= pixels[i] > 0;
      opaque &&= pixels[i] === 255;
    }
    return opaque ? "opaque" : visible ? "nonopaque" : "transparent";
  } catch {
    return "unknown";
  } finally {
    bitmap?.close();
  }
}
