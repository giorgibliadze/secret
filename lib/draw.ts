import { randomInt } from "node:crypto";
export function drawRecipients(count = 6): number[] {
  if (!Number.isInteger(count) || count < 2) throw new Error("Invalid count");
  let recipients: number[];
  do {
    recipients = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [recipients[i], recipients[j]] = [recipients[j], recipients[i]];
    }
  } while (recipients.some((recipient, i) => recipient === i));
  return recipients;
}
