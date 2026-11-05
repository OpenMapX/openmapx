/** Verify the installed Java boundary, rather than merely the patch declaration. */
export function hasWebViewCaptureDenial(source: string): boolean {
  const method = source.split(
    "public void onPermissionRequest(final PermissionRequest request) {",
  )[1];
  if (!method) return false;
  const code = method
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return code.startsWith(
    "for (String resource : request.getResources()) { if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) || PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) { request.deny(); return; } }",
  );
}
