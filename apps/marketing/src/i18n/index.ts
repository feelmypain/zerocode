import { en, type Messages } from "./en";
import { fr } from "./fr";
import type { Locale } from "./locales";

const MESSAGES: Record<Locale, Messages> = {
  en,
  fr,
};

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale];
