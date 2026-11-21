"use client";
import {
  type AbstractIntlMessages,
  NextIntlClientProvider,
  useLocale,
  useMessages,
  useTimeZone,
} from "next-intl";
import { type ReactNode, useMemo } from "react";

/**
 * Adds the admin namespaces to the public catalogue the root layout already
 * provides. A nested provider replaces its parent's messages, so the admin
 * layout sends only admin copy and this merges the two in the browser.
 */
export function AdminMessagesProvider({
  messages,
  children,
}: {
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  const locale = useLocale();
  const timeZone = useTimeZone();
  const publicMessages = useMessages();
  const merged = useMemo(() => ({ ...publicMessages, ...messages }), [publicMessages, messages]);
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={merged}>
      {children}
    </NextIntlClientProvider>
  );
}
