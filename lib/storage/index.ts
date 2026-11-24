import "server-only";
import { join } from "node:path";
import { JsonStorage } from "./transaction";
import { FileJsonDriver, readLocalJson } from "./file";
import { BlobJsonDriver } from "./blob";
export const localDataPath = () => join(process.cwd(), "data", "secret-santa.json");
export function blobStorage(path = localDataPath()) {
  // The SDK selects Vercel OIDC automatically. Local .env credentials, when present, are handled by the SDK too.
  return new JsonStorage(new BlobJsonDriver(), () => readLocalJson(path));
}
export function defaultStorage() {
  return process.env.VERCEL === "1" ? blobStorage() : new JsonStorage(new FileJsonDriver(localDataPath()));
}
