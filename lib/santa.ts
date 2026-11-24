import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { JsonStorage, type JsonTransaction } from "./storage/transaction";
import { FileJsonDriver, logStorageError } from "./storage/file";
import { defaultStorage } from "./storage";
import { drawRecipients } from "./draw";
import { ACCOUNT_EMAILS, normalizeEmail, validMapping } from "./accounts";
import { digest, newToken, validToken, validPassword, hashPassword, verifyPassword } from "./password";
import type { CardStatus } from "./card";
import { PARTICIPANTS, isParticipantName, type ParticipantName } from "./participants";

type Assignment = { name: ParticipantName; recipientName: ParticipantName; openedAt: string | null };
type Account = { name: ParticipantName; email: string; status: "pending" | "active"; activationHash: string | null; activatedAt: string | null; password: { salt: string; hash: string } | null };
type Session = { hash: string; name: ParticipantName; expiresAt: number };
type Failure = { count: number; until: number };
type Round = { version: 1; drawnAt: string | null; assignments: Assignment[]; accounts?: Account[]; sessions?: Session[]; failures?: Record<string, Failure>; enrollments?: Session[] };
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_ERROR = "ელფოსტა ან პაროლი არასწორია";
export const SETUP_SECONDS = 10 * 60;
const PAIR_ERROR = "სახელი და ელფოსტა არ ემთხვევა";

export class SantaError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function parseRound(raw: string): Round {
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !Array.isArray(value.assignments)) throw new Error("Invalid saved round");
  if (value.accounts !== undefined) {
    if (!Array.isArray(value.accounts) || !validMapping(value.accounts) || !Array.isArray(value.sessions) || !value.failures || typeof value.failures !== "object" || Array.isArray(value.failures)) throw new Error("Invalid saved accounts");
    for (const account of value.accounts) {
      const active = account.status === "active";
      if (active ? (!validDate(account.activatedAt) || account.activationHash !== null || !/^[a-f0-9]{32}$/.test(account.password?.salt ?? "") || !/^[a-f0-9]{128}$/.test(account.password?.hash ?? "")) : (account.status !== "pending" || (account.activationHash !== null && !validToken(account.activationHash)) || account.password !== null || account.activatedAt !== null)) throw new Error("Invalid account");
    }
    for (const session of value.sessions) if (!validToken(session.hash) || !isParticipantName(session.name) || !Number.isFinite(session.expiresAt)) throw new Error("Invalid session");
    for (const failure of Object.values(value.failures) as Failure[]) if (!Number.isInteger(failure?.count) || failure.count < 0 || !Number.isFinite(failure.until)) throw new Error("Invalid rate limit");
  }
  if (value.enrollments !== undefined) {
    if (!Array.isArray(value.enrollments)) throw new Error("Invalid setup sessions");
    for (const session of value.enrollments) if (!validToken(session.hash) || !isParticipantName(session.name) || !Number.isFinite(session.expiresAt)) throw new Error("Invalid setup session");
  }
  if (value.drawnAt === null && value.assignments.length === 0) return value;
  if (!validDate(value.drawnAt) || value.assignments.length !== 6) throw new Error("Invalid saved round");
  const names = new Set<string>();
  const recipients = new Set<string>();
  for (const a of value.assignments) {
    if (!a || !isParticipantName(a.name) || !isParticipantName(a.recipientName) || a.name === a.recipientName || (a.openedAt !== null && !validDate(a.openedAt))) throw new Error("Invalid saved assignment");
    names.add(a.name); recipients.add(a.recipientName);
  }
  if (names.size !== 6 || recipients.size !== 6) throw new Error("Invalid saved round");
  return value;
}
export class SantaService {
  private storage: JsonStorage;
  private transaction = new AsyncLocalStorage<JsonTransaction>();
  constructor(storage?: string | JsonStorage) {
    this.storage = typeof storage === "string" ? new JsonStorage(new FileJsonDriver(storage)) : storage ?? defaultStorage();
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.storage.run(tx => this.transaction.run(tx, operation), error => error instanceof SantaError);
  }
  private async save(round: Round) {
    const tx = this.transaction.getStore();
    if (!tx) throw new Error("Storage transaction required");
    await tx.write(JSON.stringify(round, null, 2) + "\n");
  }
  private async load(): Promise<Round> {
    const tx = this.transaction.getStore();
    if (!tx) throw new Error("Storage transaction required");
    const raw = await tx.read();
    if (raw === null) {
      const initial: Round = {
        version: 1, drawnAt: null, assignments: [],
        accounts: this.initialAccounts(), sessions: [], failures: {}, enrollments: [],
      };
      await this.save(initial);
      return initial;
    }
    // Existing account records are never reseeded; name-only legacy rounds gain accounts without changing their draw.
    let round: Round;
    try { round = parseRound(raw); }
    catch (error) { logStorageError("corrupt", error); throw error; }
    if (!round.accounts) {
      round.accounts = this.initialAccounts(); round.sessions = []; round.failures ??= {};
      await this.save(round);
    }
    return round;
  }
  async initialize() { await this.exclusive(async () => { await this.load(); }); }
  private initialAccounts(): Account[] {
    return PARTICIPANTS.map(name => ({ name, email: ACCOUNT_EMAILS[name], status: "pending", activationHash: null, activatedAt: null, password: null }));
  }
  private limited(round: Round, key: string) {
    const now = Date.now();
    round.failures ??= {};
    for (const [entry, value] of Object.entries(round.failures)) if (value.until <= now) delete round.failures[entry];
    if ((round.failures[key]?.count ?? 0) >= 5 || (round.failures.global?.count ?? 0) >= 40) throw new SantaError(429, "ძალიან ბევრი მცდელობაა. სცადე 15 წუთის შემდეგ.");
  }
  private async failed(round: Round, key: string, message: string, status = 401): Promise<never> {
    const failures = round.failures ??= {};
    for (const entry of [key, "global"]) {
      const previous = failures[entry];
      failures[entry] = { count: (previous?.count ?? 0) + 1, until: previous?.until ?? Date.now() + 15 * 60 * 1000 };
    }
    await this.save(round);
    throw new SantaError(status, message);
  }
  private card(round: Round, name: ParticipantName): CardStatus {
    const card = round.assignments.find(a => a.name === name);
    return { name, openedAt: card?.openedAt ?? null, ...(card?.openedAt ? { recipientName: card.recipientName } : {}) };
  }
  private accountForSession(round: Round, token: unknown): Account {
    const session = validToken(token) ? round.sessions?.find(s => s.hash === digest(token) && s.expiresAt > Date.now()) : undefined;
    const account = session && round.accounts?.find(a => a.name === session.name && a.status === "active");
    if (!account) throw new SantaError(401, "გთხოვ, შეხვიდე ანგარიშში.");
    return account;
  }
  private session(round: Round, account: Account) {
    const token = newToken();
    // Keep a bounded number of simultaneous devices and discard expired sessions.
    round.sessions = (round.sessions ?? []).filter(s => s.expiresAt > Date.now());
    const own = round.sessions.filter(s => s.name === account.name);
    if (own.length >= 10) round.sessions = round.sessions.filter(s => s !== own[0]);
    round.sessions.push({ hash: digest(token), name: account.name, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
    return token;
  }
  async startSetup(name: unknown, email: unknown, previousToken?: string) {
    return this.exclusive(async () => {
      const round = await this.load();
      const normalized = normalizeEmail(email);
      const key = "setup:" + digest(normalized.slice(0, 254));
      this.limited(round, key);
      const normalizedName = typeof name === "string" ? name.trim().normalize("NFC") : "";
      const account = round.accounts?.find(a => a.name === normalizedName && a.email === normalized);
      if (!account) return this.failed(round, key, PAIR_ERROR, 400);
      round.enrollments = (round.enrollments ?? []).filter(s => s.expiresAt > Date.now() && (!validToken(previousToken) || s.hash !== digest(previousToken)));
      delete round.failures![key];
      if (account.password || account.status === "active") {
        await this.save(round);
        return { mode: "login" as const };
      }
      // At most five short-lived setup sessions per participant, even across browsers.
      const own = round.enrollments.filter(s => s.name === account.name);
      if (own.length >= 5) round.enrollments = round.enrollments.filter(s => s !== own[0]);
      const token = newToken();
      round.enrollments.push({ hash: digest(token), name: account.name, expiresAt: Date.now() + SETUP_SECONDS * 1000 });
      await this.save(round);
      return { mode: "password" as const, token };
    });
  }
  async setPassword(setupToken: unknown, password: unknown) {
    return this.exclusive(async () => {
      const round = await this.load();
      const setup = validToken(setupToken) ? round.enrollments?.find(s => s.hash === digest(setupToken)) : undefined;
      if (!setup) throw new SantaError(409, "პაროლის დაყენების სესია აღარ მოქმედებს. დაიწყე თავიდან ან გამოიყენე შესვლა.");
      if (setup.expiresAt <= Date.now()) throw new SantaError(410, "სესიის ვადა გავიდა. თავიდან შეიყვანე სახელი და ელფოსტა.");
      const account = round.accounts?.find(a => a.name === setup.name);
      if (!account || account.password || account.status === "active") throw new SantaError(409, "პაროლი უკვე დაყენებულია. გამოიყენე შესვლა.");
      if (!validPassword(password)) throw new SantaError(400, "პაროლი უნდა შეიცავდეს 10–128 სიმბოლოს.");
      account.password = await hashPassword(password);
      account.status = "active"; account.activatedAt = new Date().toISOString(); account.activationHash = null;
      // Consume all setup sessions for this participant in the same atomic write as their password.
      round.enrollments = round.enrollments!.filter(s => s.name !== account.name);
      const token = this.session(round, account);
      await this.save(round);
      return { token, card: this.card(round, account.name) };
    });
  }
  async login(email: unknown, password: unknown) {
    return this.exclusive(async () => {
      const round = await this.load();
      const normalized = normalizeEmail(email).slice(0, 254);
      const key = "login:" + digest(normalized);
      this.limited(round, key);
      const account = round.accounts?.find(a => a.email === normalized && a.status === "active");
      const candidate = typeof password === "string" && password.length <= 128 ? password : "";
      const matches = await verifyPassword(candidate, account?.password);
      if (!matches || !account) return this.failed(round, key, LOGIN_ERROR);
      const token = this.session(round, account);
      delete round.failures![key];
      await this.save(round);
      return { token, card: this.card(round, account.name) };
    });
  }
  async logout(token: unknown) {
    return this.exclusive(async () => {
      const round = await this.load();
      if (!validToken(token) || !round.sessions?.some(s => s.hash === digest(token))) return;
      round.sessions = round.sessions.filter(s => s.hash !== digest(token));
      await this.save(round);
    });
  }
  async status(token: unknown): Promise<CardStatus> {
    return this.exclusive(async () => {
      const round = await this.load();
      return this.card(round, this.accountForSession(round, token).name);
    });
  }
  async reveal(token: unknown): Promise<CardStatus> {
    return this.exclusive(async () => {
      const round = await this.load();
      const account = this.accountForSession(round, token);
      if (!round.drawnAt) {
        const recipients = drawRecipients();
        round.drawnAt = new Date().toISOString();
        round.assignments = PARTICIPANTS.map((name, i) => ({ name, recipientName: PARTICIPANTS[recipients[i]], openedAt: null }));
      }
      const card = round.assignments.find(a => a.name === account.name)!;
      if (!card.openedAt) { card.openedAt = new Date().toISOString(); await this.save(round); }
      return this.card(round, account.name);
    });
  }
}
