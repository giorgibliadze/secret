import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { SantaService } from "../lib/santa";
import { handle, cookieName } from "../lib/http";
import { PARTICIPANTS } from "../lib/participants";
import { ACCOUNT_EMAILS } from "../lib/accounts";
import { drawRecipients } from "../lib/draw";
const password = "Testing-strong-password-2026";
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "secret-santa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "data", "secret-santa.json");
  const service = new SantaService(path, {});
  await service.initialize();
  return { path, service, read: async () => JSON.parse(await readFile(path, "utf8")) };
}
async function activateAll(service: SantaService) {
  const links = await service.provisionAccounts();
  const users = [];
  for (const link of links) users.push({ ...link, ...(await service.activate({ ...link, password })) });
  return users;
}
const apiFor = (path: string) => {
  const invoke = (request: Request) => handle(request, () => new SantaService(path));
  return {
    get: (cookie = "", query = "") => invoke(new Request(`http://localhost/api/santa${query}`, { headers: { cookie } })),
    post: (body: unknown, cookie = "", origin = "http://localhost") => invoke(new Request("http://localhost/api/santa", { method: "POST", headers: { cookie, origin }, body: JSON.stringify(body) })),
  };
};
test("10,000 draws have unique recipients and no self assignment", () => {
  const outcomes = new Set<string>();
  for (let i=0; i<10000; i++) {
    const r=drawRecipients(); assert.equal(new Set(r).size,6);
    r.forEach((v,j)=>{ assert.notEqual(v,j); assert.ok(v>=0 && v<6); }); outcomes.add(r.join());
  }
  assert.ok(outcomes.size>200);
});
test("confirmed mapping and account provisioning preserve all legacy pairs and opening times", async t => {
  const { path,service,read }=await setup(t);
  const legacy={version:1,drawnAt:"2026-11-20T00:00:00.000Z",assignments:PARTICIPANTS.map((name,i)=>({name,recipientName:PARTICIPANTS[(i+1)%6],openedAt:i%2 ? null:"2026-11-21T12:00:00.000Z"}))};
  await writeFile(path,JSON.stringify(legacy));
  const links=await service.provisionAccounts();
  const saved=await read();
  assert.deepEqual(saved.assignments,legacy.assignments); assert.equal(saved.drawnAt,legacy.drawnAt);
  assert.equal(saved.accounts.length,6);
  for(const link of links){
    const account=saved.accounts.find((a:{name:string})=>a.name===link.name);
    assert.equal(account.email,ACCOUNT_EMAILS[link.name]); assert.equal(account.status,"pending");
    assert.ok(!JSON.stringify(saved).includes(link.token));
  }
  await assert.rejects(service.provisionAccounts(),/already provisioned/);
  assert.deepEqual((await read()).assignments,legacy.assignments);
});
test("activation checks token/name/email, normalizes email, and atomically consumes the link",async t=>{
  const {service,read}=await setup(t);
  const links=await service.provisionAccounts(); const link=links[0];
  await assert.rejects(service.activate({...link,name:links[1].name,password}),{status:400});
  await assert.rejects(service.activate({...link,email:links[1].email,password}),{status:400});
  const active=await service.activate({...link,email:`  ${link.email.toUpperCase()}  `,password});
  assert.equal(active.card.name,link.name); assert.equal(active.card.openedAt,null);
  const saved=await read(); const account=saved.accounts[0];
  assert.equal(account.status,"active"); assert.equal(account.activationHash,null); assert.ok(account.activatedAt);
  assert.match(account.password.salt,/^[a-f0-9]{32}$/); assert.match(account.password.hash,/^[a-f0-9]{128}$/);
  assert.ok(!JSON.stringify(saved).includes(password)); assert.ok(!JSON.stringify(saved).includes(active.token));
  const stored=JSON.stringify(account.password);
  await assert.rejects(service.activate({...link,password:"Replacement-password"}),{status:400});
  assert.equal(JSON.stringify((await read()).accounts[0].password),stored);
  assert.equal((await service.status(active.token)).name,link.name);
});
test("concurrent activation can set a password only once",async t=>{
  const {service,read}=await setup(t); const [link]=await service.provisionAccounts();
  const results=await Promise.allSettled([service.activate({...link,password}),service.activate({...link,password:"Other-strong-password"})]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await read()).sessions.length,1);
  await assert.rejects(service.login(link.email,"Other-strong-password"),{status:401});
  assert.ok((await service.login(link.email,password)).token);
});
test("incorrect login is generic, cannot change a password, and has a persistent rate limit",async t=>{
  const {path,service,read}=await setup(t); const [user]=await activateAll(service);
  const before=JSON.stringify((await read()).accounts);
  for(let i=0;i<5;i++) await assert.rejects(service.login(user.email,"wrong"),{status:401,message:"ელფოსტა ან პაროლი არასწორია"});
  await assert.rejects(new SantaService(path).login(user.email,password),{status:429});
  assert.equal(JSON.stringify((await read()).accounts),before);
  await assert.rejects(service.login("not-allowed@example.com",password),{status:401,message:"ელფოსტა ან პაროლი არასწორია"});
});
test("six authenticated users reveal in different orders and retain results after another-device login",async t=>{
  const {path,service,read}=await setup(t); const users=await activateAll(service);
  assert.equal((await read()).drawnAt,null);
  const recipients=[];
  for(const i of [5,2,0,4,1,3]){
    const user=users[i]; const opened=await service.reveal(user.token);
    assert.ok(opened.openedAt); assert.notEqual(opened.recipientName,user.name); recipients.push(opened.recipientName!);
    assert.deepEqual(await service.reveal(user.token),opened);
    const second=await new SantaService(path).login(` ${user.email.toUpperCase()} `,password);
    assert.deepEqual(second.card,opened); assert.deepEqual(await service.status(second.token),opened);
  }
  assert.deepEqual(recipients.sort(),[...PARTICIPANTS].sort());
  assert.equal(new Set((await read()).accounts.map((a:{password:{salt:string}})=>a.password.salt)).size,6);
});
test("60 simultaneous reveals share one draw and retries do not write the file",async t=>{
  const {path,service}=await setup(t); const users=await activateAll(service);
  const results=await Promise.all(Array.from({length:60},(_,i)=>new SantaService(path).reveal(users[i%6].token)));
  for(const user of users){ const own=results.filter(r=>r.name===user.name); own.forEach(result=>assert.deepEqual(result,own[0])); }
  const saved=await readFile(path,"utf8");
  await Promise.all(users.map(user=>service.reveal(user.token)));
  assert.equal(await readFile(path,"utf8"),saved); assert.deepEqual(await readdir(join(path,"..")),["secret-santa.json"]);
});
test("HTTP requires session identity, protects cookies, ignores a forged name and invalidates logout",async t=>{
  const {path,service}=await setup(t); const users=await activateAll(service); const api=apiFor(path);
  assert.equal((await api.get("","?name=გიორგი")).status,401);
  assert.equal((await api.post({action:"reveal",name:users[0].name})).status,401);
  assert.equal((await api.post({action:"login",email:users[0].email,password},"","http://attacker.test")).status,403);
  const logged=await api.post({action:"login",email:users[0].email,password});
  assert.equal(logged.status,200); assert.match(logged.headers.get("cache-control")!,/no-store/);
  const cookie=logged.headers.get("set-cookie")!;
  assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/); assert.match(cookie,/Path=\//);
  if(process.env.NODE_ENV==="production"){assert.match(cookie,/^__Host-/);assert.match(cookie,/; Secure/);}
  const browser=cookie.split(";")[0];
  const revealed=await api.post({action:"reveal",name:users[1].name,email:users[1].email},browser);
  const card=await revealed.json(); assert.equal(card.name,users[0].name);
  assert.deepEqual(Object.keys(card).sort(),["name","openedAt","recipientName"]);
  assert.deepEqual(await (await api.get(browser)).json(),card);
  const logout=await api.post({action:"logout"},browser); assert.equal(logout.status,200);assert.match(logout.headers.get("set-cookie")!,/Max-Age=0/);
  assert.equal((await api.get(browser)).status,401);
  assert.equal((await api.get(`${cookieName()}=${"0".repeat(64)}`)).status,401);
});
test("activation HTTP sets a session without returning credentials or other accounts",async t=>{
  const {path,service}=await setup(t); const [link]=await service.provisionAccounts(); const api=apiFor(path);
  const response=await api.post({action:"activate",...link,password});
  assert.equal(response.status,200);assert.ok(response.headers.get("set-cookie"));
  assert.deepEqual(await response.json(),{name:link.name,openedAt:null});
  assert.equal((await api.post({action:"activate",...link,password})).status,400);
});
test("new Node process restores sessions and results after a server restart",async t=>{
  const {path,service}=await setup(t);const users=await activateAll(service);
  const expected=await Promise.all(users.map(u=>service.reveal(u.token))); const raw=await readFile(path,"utf8");
  const script=`import { SantaService } from ${JSON.stringify(pathToFileURL(resolve("lib/santa.ts")).href)};
    const service=new SantaService(process.argv[1]);
    const users=JSON.parse(process.argv[2]); const results=[];
    for(const user of users) results.push(await service.status(user.token));
    process.stdout.write(JSON.stringify(results));`;
  const {stdout}=await promisify(execFile)(process.execPath,["--conditions=react-server","--import","tsx","--input-type=module","-e",script,path,JSON.stringify(users.map(u=>({token:u.token})))]);
  assert.deepEqual(JSON.parse(stdout),expected);assert.equal(await readFile(path,"utf8"),raw);
});
test("corrupt state is never redrawn and the queue recovers after a failed operation",async t=>{
  const {path,service}=await setup(t); const [user]=await activateAll(service);const result=await service.reveal(user.token);const saved=await readFile(path,"utf8");
  await writeFile(path,"{"); await assert.rejects(service.reveal(user.token));assert.equal(await readFile(path,"utf8"),"{");
  await writeFile(path,saved);assert.deepEqual(await service.status(user.token),result);
});
test("expired sessions cannot read or open cards",async t=>{
  const {path,service,read}=await setup(t); const [user]=await activateAll(service);const saved=await read();
  saved.sessions[0].expiresAt=Date.now()-1000;await writeFile(path,JSON.stringify(saved));
  await assert.rejects(service.status(user.token),{status:401});await assert.rejects(service.reveal(user.token),{status:401});
});


test("organizer CLI refuses to replace configured activation links or existing state", async t => {
  const { path } = await setup(t);
  const cwd = join(path, "..", "..");
  await rm(path);
  const loader = createRequire(resolve("package.json")).resolve("tsx");
  const command = ["--conditions=react-server", "--import", loader, resolve("scripts/provision-accounts.ts"), "--base-url", "https://santa.example"];
  await assert.rejects(promisify(execFile)(process.execPath, command, { cwd }));
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.accounts.length, 6);
  assert.ok(saved.accounts.every((a: { activationHash: string }) => a.activationHash));
  await assert.rejects(readFile(join(cwd, "data/activation-links.txt")), { code: "ENOENT" });
});

test("first login in a missing data directory initializes all inactive accounts and continues validation", async t => {
  const { path } = await setup(t);
  await rm(join(path, ".."), { recursive: true });
  const api = apiFor(path);
  const response = await api.post({ action: "login", email: ACCOUNT_EMAILS["გიორგი"], password });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "ელფოსტა ან პაროლი არასწორია" });
  const initial = JSON.parse(await readFile(path, "utf8"));
  assert.equal(initial.accounts.length, 6);
  for (const account of initial.accounts) {
    assert.equal(account.email, ACCOUNT_EMAILS[account.name as keyof typeof ACCOUNT_EMAILS]);
    assert.equal(account.status, "pending"); assert.equal(account.password, null); assert.equal(account.activatedAt, null);
  }
  assert.equal(initial.drawnAt, null); assert.deepEqual(initial.assignments, []);
  assert.equal(Object.keys(initial.failures).length, 2); // The same request reached normal credential validation.
});

test("first activation creates missing accounts once under concurrent requests, then saved login returns its card", async t => {
  const { path } = await setup(t);
  await rm(join(path, ".."), { recursive: true });
  const { digest, newToken } = await import("../lib/password");
  const activationToken = newToken();
  let creations = 0;
  const hashes = {};
  Object.defineProperty(hashes, "გიორგი", { get() { creations++; return digest(activationToken); } });
  const request = { token: activationToken, name: "გიორგი", email: ` ${ACCOUNT_EMAILS["გიორგი"].toUpperCase()} `, password };
  const results = await Promise.allSettled([
    new SantaService(path, hashes).activate(request),
    new SantaService(path, hashes).activate({ ...request, password: "Replacement-strong-password" }),
  ]);
  assert.equal(creations, 1);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  if (results[0].status !== "fulfilled") assert.fail("activation failed");
  const activated = results[0].value;
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.accounts.length, 6); assert.equal(saved.accounts[0].status, "active");
  assert.match(saved.accounts[0].password.hash, /^[a-f0-9]{128}$/);
  assert.match(saved.accounts[0].password.salt, /^[a-f0-9]{32}$/);
  assert.equal(saved.accounts[0].activationHash, null);
  assert.equal(saved.drawnAt, null); assert.deepEqual(saved.assignments, []);
  const service = new SantaService(path);
  const card = await service.reveal(activated.token);
  await service.logout(activated.token);
  const login = await new SantaService(path).login(request.email, password);
  assert.deepEqual(login.card, card);
  assert.deepEqual(await service.reveal(login.token), card);
  assert.equal(creations, 1);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after.accounts[0].password, saved.accounts[0].password);
});

test("existing JSON is not reseeded, corrupt data and filesystem failures have separate safe logs", async t => {
  const { path, service } = await setup(t);
  const log = t.mock.method(console, "error", () => {});
  const original = await readFile(path, "utf8");
  const poisonousConfig = {};
  Object.defineProperty(poisonousConfig, "გიორგი", { get() { throw new Error("must not read bootstrap config"); } });
  await new SantaService(path, poisonousConfig).initialize();
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, "{ PRIVATE_DATA_DO_NOT_LOG");
  await assert.rejects(service.initialize());
  assert.deepEqual(log.mock.calls[0].arguments, ["[secret-santa] storage error", { kind: "corrupt" }]);
  assert.equal(await readFile(path, "utf8"), "{ PRIVATE_DATA_DO_NOT_LOG");
  const directoryAsFile = new SantaService(join(path, ".."));
  await assert.rejects(directoryAsFile.initialize());
  assert.equal(log.mock.calls[1].arguments[1].kind, "read");
  assert.equal(log.mock.calls[1].arguments[1].code, "EISDIR");
  assert.ok(!JSON.stringify(log.mock.calls).includes("PRIVATE_DATA_DO_NOT_LOG"));
});

test("initial write permission failures are logged and the missing file is not replaced", async t => {
  if (process.getuid?.() === 0) { t.skip("root bypasses filesystem permissions"); return; }
  const { path, service } = await setup(t);
  await rm(path);
  const dir = join(path, "..");
  const log = t.mock.method(console, "error", () => {});
  await chmod(dir, 0o500);
  try {
    await assert.rejects(service.initialize(), { code: "EACCES" });
    assert.ok(log.mock.calls.some(call => call.arguments[1]?.kind === "write" && call.arguments[1]?.code === "EACCES"));
  } finally { await chmod(dir, 0o700); }
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await service.initialize();
  assert.equal(JSON.parse(await readFile(path, "utf8")).accounts.length, 6);
});
