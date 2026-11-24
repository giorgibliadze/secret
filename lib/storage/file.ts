import "server-only";
import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonDriver } from "./transaction";
export function logStorageError(kind: "read" | "write" | "corrupt", error: unknown) {
  const rawCode = (error as NodeJS.ErrnoException)?.code;
  const code = typeof rawCode === "string" && /^E[A-Z0-9_]+$/.test(rawCode) ? rawCode : undefined;
  const errorType = (error as { constructor?: { name?: string } })?.constructor?.name;
  console.error("[secret-santa] storage error", { kind, ...(code ? { code } : {}), ...(/^Blob[A-Za-z]+Error$/.test(errorType ?? "") ? { errorType } : {}) });
}
export async function readLocalJson(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    logStorageError("read", error); throw error;
  }
}
export class FileJsonDriver implements JsonDriver {
  readonly concurrent = false;
  readonly key: string;
  constructor(path: string) { this.key = resolve(/* turbopackIgnore: true */ path); }
  async read() {
    const text = await readLocalJson(this.key);
    return text === null ? null : { text, revision: "local" };
  }
  async write(text: string) {
    const temporary = `${this.key}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.key), { recursive: true, mode: 0o700 });
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(text, "utf8"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.key);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    } catch (error) { logStorageError("write", error); throw error; }
  }
}
