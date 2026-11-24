import { open, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SantaService } from "../lib/santa";

async function main() {
const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
const allowed = new Set(["--base-url", "--output"]);
for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}`);
const output = resolve(option("--output") ?? "data/activation-links.txt");
const configured = option("--base-url");
let origin = "";
if (configured) {
  const url = new URL(configured);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an app origin such as https://your-app.example");
  origin = url.origin;
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const file = await open(output, "wx", 0o600);
let provisioned = false;
try {
  const links = await new SantaService().provisionAccounts();
  provisioned = true;
  await file.writeFile(links.map(link => `${link.name} <${link.email}>\n${origin}/#activate=${link.token}`).join("\n\n") + "\n");
  await file.sync();
  console.log(`Six private activation links saved to ${output}. Share each link only with its owner.`);
  if (!origin) console.log("Links are relative. Prepend the app's final origin before sharing.");
} finally {
  await file.close();
  if (!provisioned) await unlink(output);
}

}
void main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
