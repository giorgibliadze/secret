import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { JsonStorage } from "../lib/storage/transaction";
import { BlobJsonDriver, type BlobApi, BLOB_PATHNAME } from "../lib/storage/blob";
import { readLocalJson } from "../lib/storage/file";
import { SantaService } from "../lib/santa";
import { handle, cookieName, setupCookieName } from "../lib/http";
import { PARTICIPANTS } from "../lib/participants";
import { ACCOUNT_EMAILS } from "../lib/accounts";

const password = "Blob-test-strong-password";
// SDK-shaped shared remote store: distinct services have no shared JS lock, only ETag compare-and-swap.
class FakePrivateBlob implements BlobApi {
  text: string | null = null;
  version = 0;
  writes = 0;
  conflicts = 0;
  reads = 0;
  readError: Error | null = null;
  writeError: Error | null = null;
  async get(path: string, options: Parameters<BlobApi["get"]>[1]) {
    assert.equal(path, BLOB_PATHNAME); assert.equal(options.access, "private"); assert.equal(options.useCache, false); assert.equal(options.headers["accept-encoding"], "identity"); assert.ok(!("token" in options));
    this.reads++;
    if (this.readError) throw this.readError;
    const text = this.text;
    const version = this.version;
    await delay(1);
    if (text === null) return null;
    return { statusCode: 200, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }), blob: { etag: `"${version}"` } };
  }
  async put(path: string, text: string, options: Parameters<BlobApi["put"]>[2]) {
    assert.equal(path, BLOB_PATHNAME); assert.equal(options.access, "private"); assert.equal(options.addRandomSuffix, false); assert.ok(!("token" in options));
    await delay(1);
    if (this.writeError) throw this.writeError;
    if (options.allowOverwrite ? this.text === null || options.ifMatch !== `"${this.version}"` : this.text !== null) {
      this.conflicts++; throw new BlobPreconditionFailedError();
    }
    if (options.allowOverwrite) assert.ok(options.ifMatch);
    else assert.equal(options.ifMatch, undefined);
    this.text = text; this.version++; this.writes++;
    return { etag: `"${this.version}"` };
  }
}
function remote(blob: BlobApi, seed?: () => Promise<string | null>) {
  return new SantaService(new JsonStorage(new BlobJsonDriver(BLOB_PATHNAME, blob), seed));
}
async function localFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "santa-blob-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "data", "secret-santa.json");
  return { path, service: new SantaService(path) };
}
const extractCookie = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))!.split(";")[0];

test("private Blob HTTP flow: first setup, password, logout, repeat login, fresh deployment restore", async () => {
  const blob = new FakePrivateBlob();
  const post = (body: unknown, cookie = "") => handle(new Request("http://localhost/api/santa", { method: "POST", headers: { origin: "http://localhost", cookie }, body: JSON.stringify(body) }), () => remote(blob));
  const first = await post({ action: "startSetup", name: "გიორგი", email: ` ${ACCOUNT_EMAILS["გიორგი"].toUpperCase()} ` });
  assert.deepEqual(await first.json(), { mode: "password" });
  const setup = extractCookie(first, setupCookieName());
  assert.equal(JSON.parse(blob.text!).drawnAt, null);
  const activated = await post({ action: "setPassword", password }, setup);
  assert.equal(activated.status, 200);
  const session = extractCookie(activated, cookieName());
  const opened = await post({ action: "reveal" }, session);
  const card = await opened.json(); assert.ok(card.recipientName); assert.ok(card.openedAt);
  const storedPassword = JSON.parse(blob.text!).accounts[0].password;
  await post({ action: "logout" }, session);
  const login = await post({ action: "login", email: ACCOUNT_EMAILS["გიორგი"], password });
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), card);
  assert.deepEqual(JSON.parse(blob.text!).accounts[0].password, storedPassword);
  const freshSession = extractCookie(login, cookieName());
  // A fresh handler/service models a new function instance/deployment: all state comes from the same Blob.
  const restored = await handle(new Request("http://localhost/api/santa", { headers: { cookie: freshSession } }), () => remote(blob));
  assert.deepEqual(await restored.json(), card);
  assert.equal(blob.text!.includes(password), false);
});
test("migration preserves all existing accounts, hashes, sessions, pairs and opening times byte-for-byte", async t => {
  const {path,service} = await localFixture(t);
  const first = await service.startSetup("მარი", ACCOUNT_EMAILS["მარი"]);
  const active = await service.setPassword(first.token, password);
  const card = await service.reveal(active.token);
  const original = await readFile(path, "utf8");
  const blob = new FakePrivateBlob();
  await remote(blob, () => readLocalJson(path)).initialize();
  assert.equal(blob.text, original);
  assert.deepEqual((await remote(blob).login(ACCOUNT_EMAILS["მარი"], password)).card, card);
  assert.equal(await readFile(path, "utf8"), original);
});
test("existing Blob is authoritative: a redeploy never imports stale or corrupt local data", async () => {
  const blob = new FakePrivateBlob();
  const first = await remote(blob).startSetup("ანა", ACCOUNT_EMAILS["ანა"]);
  const user = await remote(blob).setPassword(first.token, password);
  const card = await remote(blob).reveal(user.token);
  const snapshot = blob.text;
  let localReads = 0;
  await remote(blob, async () => { localReads++; throw new Error("stale local data must not be read"); }).initialize();
  assert.equal(localReads, 0); assert.equal(blob.text, snapshot);
  assert.deepEqual(await remote(blob).status(user.token), card);
});
test("concurrent Blob initialization and updates retain every setup session through ETag retries", async () => {
  const blob = new FakePrivateBlob();
  const first = await Promise.all(PARTICIPANTS.map(name => remote(blob).startSetup(name, ACCOUNT_EMAILS[name])));
  assert.equal(JSON.parse(blob.text!).accounts.length, 6);
  assert.equal(JSON.parse(blob.text!).enrollments.length, 6);
  assert.ok(blob.conflicts > 0);
  for (let i = 0; i < 6; i++) assert.equal((await remote(blob).setPassword(first[i].token, password)).card.name, PARTICIPANTS[i]);
});
test("competing Blob password writes recheck single-use setup after an ETag conflict", async () => {
  const blob = new FakePrivateBlob();
  const a = await remote(blob).startSetup("გიორგი", ACCOUNT_EMAILS["გიორგი"]);
  const b = await remote(blob).startSetup("გიორგი", ACCOUNT_EMAILS["გიორგი"]);
  const results = await Promise.allSettled([remote(blob).setPassword(a.token, password), remote(blob).setPassword(b.token, "Other-strong-password")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const losing = results.find(r => r.status === "rejected"); assert.equal(losing?.status === "rejected" && losing.reason.status, 409);
  assert.ok(blob.conflicts > 0);
  assert.equal(JSON.parse(blob.text!).sessions.length, 1);
});
test("concurrent Blob card openings share one persistent draw and all six recipients remain unique", async t => {
  const {path,service} = await localFixture(t);
  const users = [];
  for (const name of PARTICIPANTS) {
    const setup = await service.startSetup(name, ACCOUNT_EMAILS[name]);
    users.push(await service.setPassword(setup.token, password));
  }
  const blob = new FakePrivateBlob();
  await remote(blob, () => readLocalJson(path)).initialize();
  const cards = await Promise.all(users.map(user => remote(blob).reveal(user.token)));
  assert.equal(new Set(cards.map(c => c.recipientName)).size, 6);
  for (let i = 0; i < 6; i++) assert.notEqual(cards[i].recipientName, PARTICIPANTS[i]);
  const snapshot = blob.text;
  for (let i = 0; i < 6; i++) assert.deepEqual(await remote(blob).reveal(users[i].token), cards[i]);
  assert.equal(blob.text, snapshot);
});
test("auth failures also use conditional writes so rate-limit increments cannot be lost", async () => {
  const blob = new FakePrivateBlob();
  await remote(blob).initialize();
  const results = await Promise.allSettled(Array.from({length: 5}, () => remote(blob).login("unknown@example.com", "wrong")));
  assert.ok(results.every(r => r.status === "rejected" && r.reason.status === 401));
  assert.equal(JSON.parse(blob.text!).failures.global.count, 5);
  await assert.rejects(remote(blob).login("unknown@example.com", "wrong"), {status: 429});
});
test("Blob read/access/corruption/write failures never seed or reset data", async t => {
  t.mock.method(console, "error", () => {});
  const blob = new FakePrivateBlob();
  let seedReads = 0;
  const service = () => remote(blob, async () => { seedReads++; return null; });
  blob.readError = new Error("access denied");
  await assert.rejects(service().initialize()); assert.equal(seedReads, 0); assert.equal(blob.writes, 0);
  blob.readError = null; blob.text = "{ CORRUPTED"; blob.version = 1;
  await assert.rejects(service().initialize()); assert.equal(seedReads, 0); assert.equal(blob.writes, 0); assert.equal(blob.text, "{ CORRUPTED");
  blob.text = null; blob.writeError = new Error("forbidden");
  await assert.rejects(service().initialize()); assert.equal(blob.text, null); assert.equal(blob.writes, 0);
});
test("corrupt local migration input is never committed to a missing Blob", async t => {
  t.mock.method(console, "error", () => {});
  const blob = new FakePrivateBlob();
  await assert.rejects(remote(blob, async () => "{ CORRUPTED").initialize());
  assert.equal(blob.writes, 0); assert.equal(blob.text, null);
});
