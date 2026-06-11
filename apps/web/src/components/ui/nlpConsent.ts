const KEY = "openmapx.nlp.cloudConsent";

export function hasNlpConsent(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function isNlpCloudDeclined(): boolean {
  try {
    return localStorage.getItem(KEY) === "false";
  } catch {
    return false;
  }
}

export function setNlpConsent(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? "true" : "false");
  } catch {}
}
