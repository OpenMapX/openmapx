// Contains no draft content. The root provider owns the actual beforeunload listener.
let bypass: { until: number } | null = null;
export function allowAdminDocumentExit(reason: "download" | "reauthentication"): () => void {
  void reason;
  const token = { until: Date.now() + 1000 };
  bypass = token;
  return () => {
    if (bypass === token) bypass = null;
  };
}
export function consumeAdminDocumentExitAllowance(): boolean {
  const allowed = bypass !== null && Date.now() <= bypass.until;
  bypass = null;
  return allowed;
}

export function navigateAdminDocument(url: string, reason: "download" | "reauthentication") {
  const restore = allowAdminDocumentExit(reason);
  try {
    window.location.assign(url);
  } catch (error) {
    restore();
    throw error;
  }
}
