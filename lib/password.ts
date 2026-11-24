import "server-only";
import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("hex");
export const validToken = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validPassword(value: unknown): value is string { return typeof value === "string" && value.length >= 10 && value.length <= 128; }
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: (await derive(password, salt)).toString("hex") };
}
export async function verifyPassword(password: string, stored?: { salt: string; hash: string } | null) {
  // Same expensive operation for an unknown email or an unactivated account.
  const candidate = await derive(password, stored?.salt ?? "00000000000000000000000000000000");
  const expected = stored ? Buffer.from(stored.hash, "hex") : Buffer.alloc(64);
  return timingSafeEqual(candidate, expected) && !!stored;
}
