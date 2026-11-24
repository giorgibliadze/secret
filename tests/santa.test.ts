import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
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
  const service = new SantaService(path);
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


test("organizer CLI creates six private links once and never overwrites existing state", async t => {
  const { path } = await setup(t);
  const cwd = join(path, "..", "..");
  const loader = createRequire(resolve("package.json")).resolve("tsx");
  const command = ["--conditions=react-server", "--import", loader, resolve("scripts/provision-accounts.ts"), "--base-url", "https://santa.example"];
  const run = () => promisify(execFile)(process.execPath, command, { cwd });
  const result = await run();
  assert.ok(!result.stdout.includes("#activate="));
  const exported = await readFile(join(cwd, "data/activation-links.txt"), "utf8");
  assert.equal((exported.match(/https:\/\/santa\.example\/#activate=[a-f0-9]{64}/g) ?? []).length, 6);
  const saved = await readFile(path, "utf8");
  await assert.rejects(run());
  assert.equal(await readFile(path, "utf8"), saved);
  assert.equal(await readFile(join(cwd, "data/activation-links.txt"), "utf8"), exported);
});
