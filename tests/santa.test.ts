import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SantaService } from "../lib/santa";
import { handle } from "../lib/http";
import { PARTICIPANTS } from "../lib/participants";
import { drawRecipients } from "../lib/draw";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "secret-santa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "data", "secret-santa.json");
  return { path, service: new SantaService(path), read: async () => JSON.parse(await readFile(path, "utf8")) };
}

test("10,000 draws have six unique recipients and no self assignment", () => {
  const outcomes = new Set<string>();
  for (let i = 0; i < 10000; i++) {
    const recipients = drawRecipients();
    assert.equal(new Set(recipients).size, 6);
    recipients.forEach((recipient, giver) => { assert.notEqual(recipient, giver); assert.ok(recipient >= 0 && recipient < 6); });
    outcomes.add(recipients.join());
  }
  assert.ok(outcomes.size > 200);
});

test("file is automatic; visiting and selecting names do not draw", async t => {
  const { path, service, read } = await setup(t);
  await Promise.all(Array.from({ length: 10 }, () => new SantaService(path).initialize()));
  for (const name of PARTICIPANTS) assert.deepEqual(await service.status(name), { name, openedAt: null });
  assert.deepEqual(await read(), { version: 1, drawnAt: null, assignments: [] });
  await service.reveal("გიორგი");
  assert.equal((await read()).assignments.length, 6);
  assert.ok((await read()).drawnAt);
  assert.equal((await read()).assignments.filter((a: { openedAt: string | null }) => a.openedAt).length, 1);
});

test("six cards in different orders retain their results on refresh and reselection", async t => {
  for (const order of [[0, 1, 2, 3, 4, 5], [5, 2, 0, 4, 1, 3], [3, 1, 4, 0, 5, 2]]) {
    const { path, service } = await setup(t);
    const recipients: string[] = [];
    for (const index of order) {
      const name = PARTICIPANTS[index];
      assert.deepEqual(await service.status(name), { name, openedAt: null });
      const opened = await service.reveal(name);
      assert.ok(opened.openedAt); assert.ok(opened.recipientName);
      assert.notEqual(opened.recipientName, name);
      recipients.push(opened.recipientName!);
      assert.deepEqual(await service.reveal(name), opened);
      assert.deepEqual(await new SantaService(path).status(name), opened);
      assert.deepEqual(Object.keys(opened).sort(), ["name", "openedAt", "recipientName"]);
    }
    assert.deepEqual(recipients.sort(), [...PARTICIPANTS].sort());
  }
});

test("simultaneous first clicks from distinct service instances create one shared draw", async t => {
  const { path, read } = await setup(t);
  const requests = Array.from({ length: 60 }, (_, i) => new SantaService(path).reveal(PARTICIPANTS[i % 6]));
  const responses = await Promise.all(requests);
  const saved = await read();
  assert.equal(saved.assignments.length, 6);
  assert.equal(new Set(saved.assignments.map((a: { recipientName: string }) => a.recipientName)).size, 6);
  for (const name of PARTICIPANTS) {
    const matches = responses.filter(response => response.name === name);
    for (const result of matches) assert.deepEqual(result, matches[0]);
  }
  const raw = await readFile(path, "utf8");
  await Promise.all(PARTICIPANTS.map(name => new SantaService(path).reveal(name)));
  assert.equal(await readFile(path, "utf8"), raw);
  assert.deepEqual(await readdir(join(path, "..")), ["secret-santa.json"]);
});

test("a fresh Node.js process loads exactly the saved results after restart", async t => {
  const { path, service } = await setup(t);
  const expected = await Promise.all(PARTICIPANTS.map(name => service.reveal(name)));
  const raw = await readFile(path, "utf8");
  const script = `
    import { SantaService } from ${JSON.stringify(pathToFileURL(resolve("lib/santa.ts")).href)};
    const service = new SantaService(process.argv[1]);
    const results = [];
    for (const name of ${JSON.stringify(PARTICIPANTS)}) results.push(await service.status(name));
    process.stdout.write(JSON.stringify(results));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script, path]);
  assert.deepEqual(JSON.parse(stdout), expected);
  assert.equal(await readFile(path, "utf8"), raw);
});

test("API only returns the selected card and hiding/switching cannot reset it", async t => {
  const { path, service } = await setup(t);
  const api = (request: Request) => handle(request, () => new SantaService(path));
  const get = (name?: string) => api(new Request(`http://localhost/api/santa${name ? `?name=${encodeURIComponent(name)}` : ""}`));
  const post = (name: unknown, origin = "http://localhost", action = "reveal") => api(new Request("http://localhost/api/santa", { method: "POST", headers: { origin }, body: JSON.stringify({ action, name }) }));
  for (const name of [null, "", "სხვა", {}]) assert.equal((await post(name)).status, 404);
  assert.equal((await post("გიორგი", "http://other.test")).status, 403);
  assert.equal((await post("გიორგი", "http://localhost", "register")).status, 400);
  const response = await post("მარი");
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ["name", "openedAt", "recipientName"]);
  const saved = await readFile(path, "utf8");
  assert.equal((await get()).status, 404);
  assert.deepEqual(await (await get()).json(), { error: "სახელი ვერ მოიძებნა" });
  assert.deepEqual(await (await get("ანა")).json(), { name: "ანა", openedAt: null });
  assert.deepEqual(await (await get("მარი")).json(), result);
  assert.deepEqual(await service.reveal("მარი"), result);
  assert.equal(await readFile(path, "utf8"), saved);
});

test("corrupt saved state fails closed and a failed operation does not block the queue", async t => {
  const { path, service } = await setup(t);
  const result = await service.reveal("ნინი");
  const saved = await readFile(path, "utf8");
  for (const corrupt of ["{", '{"version":1,"drawnAt":null,"assignments":[{}]}']) {
    await writeFile(path, corrupt);
    await assert.rejects(service.reveal("ნინი"));
    assert.equal(await readFile(path, "utf8"), corrupt);
  }
  await writeFile(path, saved);
  assert.deepEqual(await service.status("ნინი"), result);
});

test("concurrent filesystem readers only observe complete JSON during atomic writes", async t => {
  const { path, service } = await setup(t);
  await service.initialize();
  let complete = false;
  const writes = Promise.all(PARTICIPANTS.map(name => service.reveal(name))).finally(() => { complete = true; });
  let reads = 0;
  while (!complete) {
    const round = JSON.parse(await readFile(path, "utf8"));
    assert.ok(round.assignments.length === 0 || round.assignments.length === 6);
    reads++;
  }
  await writes;
  assert.ok(reads > 0);
});


test("unknown names return the exact message; status never exposes the roster", async t => {
  const { path } = await setup(t);
  const status = (name: unknown) => handle(new Request("http://localhost/api/santa", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify({ action: "status", name }) }), () => new SantaService(path));
  for (const name of ["უცნობი", "", null, PARTICIPANTS, { name: "გიორგი" }]) {
    const response = await status(name);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "სახელი ვერ მოიძებნა" });
  }
  const correct = await status("გიორგი");
  assert.equal(correct.status, 200);
  assert.deepEqual(await correct.json(), { name: "გიორგი", openedAt: null });
  await new SantaService(path).reveal("გიორგი");
  const returning = await status("გიორგი");
  assert.deepEqual(await returning.json(), await new SantaService(path).status("გიორგი"));
});
