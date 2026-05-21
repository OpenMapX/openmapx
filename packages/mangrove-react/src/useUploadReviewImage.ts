import { useMutation } from "@tanstack/react-query";
import { useMangroveTransport } from "./provider";

/**
 * MIME types we preserve on re-encode. Anything else falls back to JPEG so we
 * never ship an unrecognized format to the image CDN.
 */
const PASSTHROUGH_MIME: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * Strip EXIF/XMP/IPTC metadata (and any other ancillary chunks) by re-encoding
 * the image through a Canvas. Browsers bundled canvas encoders only emit the
 * pixel data and baseline header — metadata is discarded as a side effect.
 *
 * `createImageBitmap(..., { imageOrientation: "from-image" })` applies any
 * EXIF Orientation flag to the pixels before we drop the tag, so the uploaded
 * image still appears right-side-up.
 */
async function stripImageMetadata(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement("canvas"), {
            width: bitmap.width,
            height: bitmap.height,
          });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0);

    const outType = PASSTHROUGH_MIME.includes(file.type) ? file.type : "image/jpeg";
    const quality = outType === "image/jpeg" || outType === "image/webp" ? 0.92 : undefined;

    const blob =
      canvas instanceof OffscreenCanvas
        ? await canvas.convertToBlob({ type: outType, quality })
        : await new Promise<Blob>((resolve, reject) => {
            (canvas as HTMLCanvasElement).toBlob(
              (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
              outType,
              quality,
            );
          });

    const extMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const newName = renameExtension(file.name, extMap[outType] ?? "jpg");
    return new File([blob], newName, { type: outType, lastModified: Date.now() });
  } finally {
    bitmap.close?.();
  }
}

function renameExtension(filename: string, ext: string): string {
  const stem = filename.replace(/\.[^./\\]+$/, "");
  return `${stem || "image"}.${ext}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads a review image via the host transport. The image is first re-encoded
 * client-side to strip EXIF/location/camera metadata before leaving the
 * browser. Returns the absolute URL ready to plug into a review's `images[]`.
 */
export function useUploadReviewImage() {
  const transport = useMangroveTransport();
  return useMutation({
    mutationFn: async (file: File): Promise<{ src: string }> => {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error("Image exceeds 5 MB");
      }
      const stripped = await stripImageMetadata(file);
      const dataUrl = await fileToDataUrl(stripped);
      return transport.uploadReviewImage({ dataUrl, filename: stripped.name });
    },
  });
}
