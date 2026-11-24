import "server-only";
export const PARTICIPANTS = ["გიორგი", "ნინი", "მარი", "ანა", "რეზი", "სოსო"] as const;
export type ParticipantName = (typeof PARTICIPANTS)[number];
export function isParticipantName(value: unknown): value is ParticipantName {
  return typeof value === "string" && PARTICIPANTS.some(name => name === value);
}
