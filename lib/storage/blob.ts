import "server-only";
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { StorageConflict, type JsonDriver } from "./transaction";
import { logStorageError } from "./file";
export const BLOB_PATHNAME = "secret-santa/secret-santa.json";
export type BlobApi = {
  get: (path: string, options: { access: "private"; useCache: false; headers: { "accept-encoding": "identity" } }) => Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null; blob: { etag: string } } | null>;
  put: (path: string, text: string, options: { access: "private"; addRandomSuffix: false; allowOverwrite: boolean; contentType: string; ifMatch?: string }) => Promise<unknown>;
};
export class BlobJsonDriver implements JsonDriver {
  readonly concurrent = true;
  readonly key: string;
  constructor(readonly pathname = BLOB_PATHNAME, private api: BlobApi = { get, put }) {
    this.key = `blob:${pathname}`;
  }
  async read() {
    try {
      const result = await this.api.get(this.pathname, { access: "private", useCache: false, headers: { "accept-encoding": "identity" } });
      if (result === null) return null; // Only a definitive blob 404 means missing data.
      if (result.statusCode !== 200 || !result.stream || !result.blob.etag) throw new Error("Invalid Blob snapshot");
      return { text: await new Response(result.stream).text(), revision: result.blob.etag };
    } catch (error) { logStorageError("read", error); throw error; }
  }
  async write(text: string, revision: string | null) {
    try {
      await this.api.put(this.pathname, text, {
        access: "private", contentType: "application/json", addRandomSuffix: false,
        allowOverwrite: revision !== null,
        ...(revision !== null ? { ifMatch: revision } : {}),
      });
    } catch (error) {
      // Creation is also conditional: allowOverwrite=false prevents a second initializer overwriting the winner.
      if (error instanceof BlobPreconditionFailedError || (revision === null && error instanceof Error && /already exists/i.test(error.message))) throw new StorageConflict();
      logStorageError("write", error); throw error;
    }
  }
}
