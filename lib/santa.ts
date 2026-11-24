import "server-only";
import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { drawRecipients } from "./draw";
import { INITIAL_ACTIVATION_HASHES } from "./activation-config";
import { ACCOUNT_EMAILS, normalizeEmail, validMapping } from "./accounts";
import { digest, newToken, validToken, validPassword, hashPassword, verifyPassword } from "./password";
import type { CardStatus } from "./card";
import { PARTICIPANTS, isParticipantName, type ParticipantName } from "./participants";

type Assignment = { name: ParticipantName; recipientName: ParticipantName; openedAt: string | null };
type Account = { name: ParticipantName; email: string; status: "pending" | "active"; activationHash: string | null; activatedAt: string | null; password: { salt: string; hash: string } | null };
type Session = { hash: string; name: ParticipantName; expiresAt: number };
type Failure = { count: number; until: number };
type Round = { version: 1; drawnAt: string | null; assignments: Assignment[]; accounts?: Account[]; sessions?: Session[]; failures?: Record<string, Failure> };
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_ERROR = "ელფოსტა ან პაროლი არასწორია";
const ACTIVATION_ERROR = "გასააქტიურებელი ბმული ან მონაცემები არასწორია";

// Shared across service instances and module reloads within this Node.js process.
const processState = globalThis as typeof globalThis & { santaFileQueues?: Map<string, Promise<void>> };
const queues = processState.santaFileQueues ??= new Map<string, Promise<void>>();

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
  private path: string;
  constructor(path = join(process.cwd(), "data", "secret-santa.json"), private initialActivationHashes = INITIAL_ACTIVATION_HASHES) { this.path = resolve(/* turbopackIgnore: true */ path); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(() => {}, () => {});
    queues.set(this.path, settled);
    try { return await current; }
    finally { if (queues.get(this.path) === settled) queues.delete(this.path); }
  }
  private async save(round: Round) {
    try { await this.atomicSave(round); }
    catch (error) { this.storageError("write", error); throw error; }
  }
  private async atomicSave(round: Round) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(round, null, 2) + "\n", "utf8"); await file.sync(); }
      finally { await file.close(); }
      // Same directory/filesystem: readers see either the old complete file or the new complete file.
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  private storageError(kind: "read" | "write" | "corrupt", error: unknown) {
    // Never log the file contents, passwords, activation tokens, or raw error messages.
    const rawCode = (error as NodeJS.ErrnoException)?.code;
    const code = typeof rawCode === "string" && /^E[A-Z0-9_]+$/.test(rawCode) ? rawCode : undefined;
    console.error("[secret-santa] storage error", { kind, ...(code ? { code } : {}) });
  }
  private async load(): Promise<Round> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.storageError("read", error);
        throw error;
      }
      // All callers hold the same per-file queue. Only an actually missing file is initialized.
      const initial: Round = {
        version: 1, drawnAt: null, assignments: [],
        accounts: PARTICIPANTS.map(name => {
          const activationHash = this.initialActivationHashes[name] ?? null;
          if (activationHash !== null && !validToken(activationHash)) throw new Error("Invalid bootstrap activation hash");
          return { name, email: ACCOUNT_EMAILS[name], status: "pending", activationHash, activatedAt: null, password: null };
        }),
        sessions: [], failures: {},
      };
      await this.save(initial);
      return initial;
    }
    // Existing files are read as-is. Neither corrupt data nor permission errors trigger replacement.
    try { return parseRound(raw); }
    catch (error) { this.storageError("corrupt", error); throw error; }
  }
  async initialize() { await this.exclusive(async () => { await this.load(); }); }
  async provisionAccounts() {
    return this.exclusive(async () => {
      const round = await this.load();
      if (round.accounts?.some(account => account.status !== "pending" || account.activationHash !== null)) throw new Error("Accounts already provisioned; existing accounts and links were not changed.");
      const links = PARTICIPANTS.map(name => ({ name, email: ACCOUNT_EMAILS[name], token: newToken() }));
      round.accounts = links.map(({ name, email, token }) => ({ name, email, status: "pending", activationHash: digest(token), activatedAt: null, password: null }));
      round.sessions = []; round.failures = {};
      await this.save(round);
      return links;
    });
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
  async activate(input: { token?: unknown; name?: unknown; email?: unknown; password?: unknown }) {
    return this.exclusive(async () => {
      const round = await this.load();
      const key = "activate:" + digest(typeof input.token === "string" ? input.token.slice(0, 128) : "");
      this.limited(round, key);
      const account = validToken(input.token) && round.accounts?.find(a => a.activationHash === digest(input.token as string) && a.status === "pending");
      const name = typeof input.name === "string" ? input.name.trim().normalize("NFC") : "";
      if (!account || account.name !== name || account.email !== normalizeEmail(input.email)) return this.failed(round, key, ACTIVATION_ERROR, 400);
      if (!validPassword(input.password)) throw new SantaError(400, "პაროლი უნდა შეიცავდეს 10–128 სიმბოლოს.");
      account.password = await hashPassword(input.password);
      account.status = "active"; account.activatedAt = new Date().toISOString(); account.activationHash = null;
      const token = this.session(round, account);
      delete round.failures![key];
      // Account activation, password, link consumption, and session are one atomic write.
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
