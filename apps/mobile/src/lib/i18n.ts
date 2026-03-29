import { de, en } from "@openmapx/i18n";
import { getLocales } from "expo-localization";
import i18n from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { createMMKV } from "react-native-mmkv";

const mmkv = createMMKV();
const LANG_KEY = "openmapx:language";

const storedLng = mmkv.getString(LANG_KEY);
const deviceLng = getLocales()[0]?.languageCode ?? "en";
const initialLng = storedLng ?? deviceLng;

i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
    },
    lng: initialLng,
    fallbackLng: "en",
    defaultNS: "translation",
    interpolation: { escapeValue: false },
  });

i18n.on("languageChanged", (lng) => {
  mmkv.set(LANG_KEY, lng);
});

export default i18n;
