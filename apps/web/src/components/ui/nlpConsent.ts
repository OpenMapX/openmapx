const KEY = "openmapx.nlp.cloudConsent";

export function getNlpConsent(): boolean | null {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function hasNlpConsent(): boolean {
  return getNlpConsent() === true;
}

export function isNlpCloudDeclined(): boolean {
  return getNlpConsent() === false;
}

export function setNlpConsent(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? "true" : "false");
  } catch {}
}
