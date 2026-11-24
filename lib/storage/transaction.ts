import "server-only";
import { setTimeout as delay } from "node:timers/promises";
export type Snapshot = { text: string; revision: string } | null;
export interface JsonDriver {
  readonly key: string;
  readonly concurrent: boolean;
  read(): Promise<Snapshot>;
  write(text: string, revision: string | null): Promise<void>;
}
export class StorageConflict extends Error {
  constructor() { super("Concurrent storage update"); }
}
export interface JsonTransaction { read(): Promise<string | null>; write(text: string): Promise<void> }
const state = globalThis as typeof globalThis & { santaStorageQueues?: Map<string, Promise<void>> };
const queues = state.santaStorageQueues ??= new Map<string, Promise<void>>();
export class JsonStorage {
  constructor(readonly driver: JsonDriver, private seed?: () => Promise<string | null>) {}
  async run<T>(operation: (transaction: JsonTransaction) => Promise<T>, commitOnError: (error: unknown) => boolean): Promise<T> {
    if (this.driver.concurrent) return this.attempt(operation, commitOnError);
    const previous = queues.get(this.driver.key) ?? Promise.resolve();
    const next = previous.then(() => this.attempt(operation, commitOnError));
    const settled = next.then(() => {}, () => {});
    queues.set(this.driver.key, settled);
    try { return await next; }
    finally { if (queues.get(this.driver.key) === settled) queues.delete(this.driver.key); }
  }
  private async attempt<T>(operation: (transaction: JsonTransaction) => Promise<T>, commitOnError: (error: unknown) => boolean): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await this.driver.read();
      // The remote record always wins. Local migration is considered only after a definitive remote 404.
      const seed = snapshot === null && this.seed ? await this.seed() : null;
      let staged: string | undefined = seed ?? undefined;
      const transaction: JsonTransaction = {
        read: async () => staged ?? snapshot?.text ?? null,
        write: async text => { staged = text; },
      };
      let result!: T;
      let failed = false;
      let failure: unknown;
      try { result = await operation(transaction); }
      catch (error) {
        if (!commitOnError(error)) throw error;
        failed = true; failure = error;
      }
      if (staged !== undefined && staged !== snapshot?.text) {
        try { await this.driver.write(staged, snapshot?.revision ?? null); }
        catch (error) {
          if (!(error instanceof StorageConflict)) throw error;
          // Re-run the entire domain operation against a fresh snapshot, including password/setup checks.
          if (attempt === 19) throw error;
          await delay(Math.min(5 * 2 ** attempt, 100) + Math.floor(Math.random() * 15));
          continue;
        }
      }
      if (failed) throw failure;
      return result;
    }
    throw new StorageConflict();
  }
}
