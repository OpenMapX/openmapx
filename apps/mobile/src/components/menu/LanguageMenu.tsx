import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Portal, RadioButton } from "react-native-paper";

const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
];

interface LanguageMenuProps {
  visible: boolean;
  onDismiss: () => void;
}

export function LanguageMenu({ visible, onDismiss }: LanguageMenuProps) {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language;

  const handleSelect = useCallback(
    (code: string) => {
      if (code !== currentLang) {
        void i18n.changeLanguage(code);
      }
      onDismiss();
    },
    [currentLang, i18n, onDismiss],
  );

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>{t("menu.language")}</Dialog.Title>
        <Dialog.Content>
          <RadioButton.Group value={currentLang} onValueChange={handleSelect}>
            {LANGUAGES.map((lang) => (
              <RadioButton.Item key={lang.code} label={lang.label} value={lang.code} />
            ))}
          </RadioButton.Group>
        </Dialog.Content>
      </Dialog>
    </Portal>
  );
}
