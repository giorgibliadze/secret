import { loadEnvConfig } from "@next/env";
import { SantaService } from "../lib/santa";
import { blobStorage, localDataPath } from "../lib/storage";
import { readLocalJson } from "../lib/storage/file";
async function main() {
  loadEnvConfig(process.cwd());
  const path = localDataPath();
  if (await readLocalJson(path) === null) { console.error("Local data/secret-santa.json is missing from this build; no empty round was created."); throw new Error("Missing migration source"); }
  // Blob data always takes precedence; this command never overwrites an existing remote record.
  await new SantaService(blobStorage(path)).initialize();
  console.log("Private Blob checked. Existing remote data was preserved; missing remote data was imported from local JSON.");
}
void main().catch(() => { console.error("Migration failed. Check the private Blob OIDC access and saved JSON; no fallback reset was performed."); process.exitCode = 1; });
