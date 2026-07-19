import { describe, expect, it } from "vitest";
import { selectVoice } from "./useNavigationVoice";

const v = (name: string, lang: string) => ({ name, lang });

describe("selectVoice", () => {
  const voices = [v("Alice", "en-GB"), v("Bob", "en-US"), v("Klaus", "de-DE")];

  it("prefers the named voice over the locale match", () => {
    expect(selectVoice(voices, "en-US", "Klaus")?.name).toBe("Klaus");
  });

  it("falls back to the locale when the named voice is gone", () => {
    expect(selectVoice(voices, "en-US", "Nope")?.name).toBe("Bob");
  });

  it("matches the exact locale, then the base language", () => {
    expect(selectVoice(voices, "en-US")?.name).toBe("Bob");
    expect(selectVoice([v("Alice", "en-GB")], "en-US")?.name).toBe("Alice");
  });

  it("returns undefined when nothing matches", () => {
    expect(selectVoice([v("Klaus", "de-DE")], "fr-FR")).toBeUndefined();
  });
});
