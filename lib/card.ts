// Browser-safe response shape; the participant roster lives only on the server.
export type CardStatus = { name: string; openedAt: string | null; recipientName?: string };
