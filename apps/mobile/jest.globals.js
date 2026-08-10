// Expo installs its WinterCG globals (`URL`, `fetch`, `TextDecoder`, ...) as
// lazy proxies whose getters `require()` the implementation on first access.
// Under Jest 30 that `require` throws "outside of the scope of the test code"
// when it happens while a test module is being loaded. Touching each global
// here — during `setupFiles`, which is a legal phase — resolves them once and
// replaces the proxies with concrete values.
for (const name of [
  "URL",
  "URLSearchParams",
  "TextDecoder",
  "TextDecoderStream",
  "TextEncoderStream",
  "DOMException",
  "structuredClone",
  "__ExpoImportMetaRegistry",
  "fetch",
]) {
  try {
    void globalThis[name];
  } catch {
    // A global this runtime does not provide is not a problem for these tests.
  }
}
