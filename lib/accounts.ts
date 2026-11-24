import "server-only";
import { PARTICIPANTS, type ParticipantName } from "./participants";
// Confirmed by the organizer. This module must never be imported into the browser.
export const ACCOUNT_EMAILS: Record<ParticipantName, string> = {
  "გიორგი": "bliadze1997@gmail.com",
  "ნინი": "chagalidze.nin@gmail.com",
  "მარი": "mgaldava7@gmail.com",
  "ანა": "kniazianiana12@gmail.com",
  "რეზი": "rezvarda.k@gmail.com",
  "სოსო": "lkiraaa1137@gmail.com",
};
export const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
export function validMapping(accounts: { name: string; email: string }[]) {
  return accounts.length === 6 && PARTICIPANTS.every(name => accounts.filter(a => a.name === name && a.email === ACCOUNT_EMAILS[name]).length === 1);
}
