import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SantaService } from "../lib/santa";
import { handle, cookieName, setupCookieName } from "../lib/http";
import { PARTICIPANTS } from "../lib/participants";
import { ACCOUNT_EMAILS } from "../lib/accounts";
import { drawRecipients } from "../lib/draw";
const password = "Testing-strong-password-2026";
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "secret-santa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "data", "secret-santa.json");
  return { path, service: new SantaService(path), read: async () => JSON.parse(await readFile(path, "utf8")) };
}
async function enroll(service: SantaService, name = PARTICIPANTS[0] as typeof PARTICIPANTS[number]) {
  const result = await service.startSetup(name, ACCOUNT_EMAILS[name]);
  assert.equal(result.mode, "password");
  if (result.mode !== "password") assert.fail("expected password step");
  return { name, email: ACCOUNT_EMAILS[name], ...(await service.setPassword(result.token, password)) };
}
const apiFor = (path: string) => {
  const invoke = (request: Request) => handle(request, () => new SantaService(path));
  return {
    get: (cookie = "", query = "") => invoke(new Request(`http://localhost/api/santa${query}`, { headers: { cookie } })),
    post: (body: unknown, cookie = "", origin = "http://localhost") => invoke(new Request("http://localhost/api/santa", { method: "POST", headers: { cookie, origin }, body: JSON.stringify(body) })),
  };
};
const responseCookie = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))!.split(";")[0];

test("10,000 draws have unique recipients and no self assignment", () => {
  for (let i = 0; i < 10000; i++) { const r = drawRecipients(); assert.equal(new Set(r).size, 6); r.forEach((v,j) => { assert.notEqual(v,j); assert.ok(v>=0 && v<6); }); }
});
test("first request in an empty folder initializes six pending accounts without drawing", async t => {
  const { service, read } = await setup(t);
  const result = await service.startSetup(" გიორგი ", ` ${ACCOUNT_EMAILS["გიორგი"].toUpperCase()} `);
  assert.equal(result.mode, "password");
  const saved = await read(); assert.equal(saved.accounts.length, 6);
  assert.equal(saved.drawnAt, null); assert.deepEqual(saved.assignments, []);
  for (const name of PARTICIPANTS) {
    const account = saved.accounts.find((a: {name:string})=>a.name===name);
    assert.equal(account.email, ACCOUNT_EMAILS[name]); assert.equal(account.status, "pending"); assert.equal(account.password, null);
  }
  assert.equal(saved.enrollments.length,1);
  assert.ok(!JSON.stringify(saved).includes(result.token!));
});
test("mismatched pairs return the exact error and do not issue a setup cookie", async t => {
  const { path, read } = await setup(t); const api = apiFor(path);
  for (const body of [{name:"გიორგი",email:ACCOUNT_EMAILS["ანა"]},{name:"უცნობი",email:ACCOUNT_EMAILS["გიორგი"]},{name:"",email:""}]) {
    const response = await api.post({action:"startSetup",...body});
    assert.equal(response.status,400); assert.deepEqual(await response.json(),{error:"სახელი და ელფოსტა არ ემთხვევა"}); assert.equal(response.headers.get("set-cookie"),null);
  }
  assert.equal((await read()).enrollments.length,0);
  assert.equal((await api.post({action:"setPassword",password})).status,409);
});
test("two-step HTTP setup uses an HttpOnly cookie, ignores forged identity and signs in immediately", async t => {
  const { path,read }=await setup(t); const api=apiFor(path);
  const first=await api.post({action:"startSetup",name:" გიორგი ",email:` ${ACCOUNT_EMAILS["გიორგი"].toUpperCase()} `});
  assert.equal(first.status,200); assert.deepEqual(await first.json(),{mode:"password"});
  const header=first.headers.getSetCookie()[0]; assert.match(header,/HttpOnly/); assert.match(header,/SameSite=Strict/); assert.match(header,/Max-Age=600/);
  if(process.env.NODE_ENV==="production"){assert.match(header,/^__Host-/);assert.match(header,/; Secure/);}
  const setupCookie=responseCookie(first,setupCookieName());
  const finish=await api.post({action:"setPassword",password,name:"ანა",email:ACCOUNT_EMAILS["ანა"]},setupCookie);
  assert.equal(finish.status,200); assert.deepEqual(await finish.json(),{name:"გიორგი",openedAt:null});
  const session=responseCookie(finish,cookieName());
  assert.equal((await api.get(session)).status,200);
  const saved=await read(); const account=saved.accounts[0];
  assert.equal(account.status,"active");assert.match(account.password.hash,/^[a-f0-9]{128}$/);assert.match(account.password.salt,/^[a-f0-9]{32}$/);
  assert.equal(saved.accounts[3].password,null);assert.equal(saved.enrollments.length,0);
  assert.ok(!JSON.stringify(saved).includes(password));
  const hash=JSON.stringify(account.password);
  assert.equal((await api.post({action:"setPassword",password:"Replacement-password"},setupCookie)).status,409);
  assert.equal(JSON.stringify((await read()).accounts[0].password),hash);
  const existing=await api.post({action:"startSetup",name:"გიორგი",email:ACCOUNT_EMAILS["გიორგი"]});
  assert.deepEqual(await existing.json(),{mode:"login"});
});
test("concurrent password writes from two verified sessions can activate an account only once", async t=>{
  const {service,read}=await setup(t);
  const [first,second]=await Promise.all([service.startSetup("გიორგი",ACCOUNT_EMAILS["გიორგი"]),service.startSetup("გიორგი",ACCOUNT_EMAILS["გიორგი"])]);
  const results=await Promise.allSettled([service.setPassword(first.token,password),service.setPassword(second.token,"Replacement-password")]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await read()).enrollments.length,0);assert.equal((await read()).sessions.length,1);
  assert.ok((await service.login(ACCOUNT_EMAILS["გიორგი"],password)).token);
  await assert.rejects(service.login(ACCOUNT_EMAILS["გიორგი"],"Replacement-password"),{status:401});
});
test("expired and forged setup sessions cannot set passwords", async t=>{
  const {path,service,read}=await setup(t); const first=await service.startSetup("გიორგი",ACCOUNT_EMAILS["გიორგი"]);
  await assert.rejects(service.setPassword("0".repeat(64),password),{status:409});
  const saved=await read();saved.enrollments[0].expiresAt=Date.now()-1000;await writeFile(path,JSON.stringify(saved));
  await assert.rejects(service.setPassword(first.token,password),{status:410});
  assert.equal((await read()).accounts[0].password,null);
});
test("correct login succeeds, incorrect login cannot change passwords and attempts are limited",async t=>{
  const {service,read}=await setup(t); const user=await enroll(service);
  const before=JSON.stringify((await read()).accounts);
  assert.equal((await service.login(` ${user.email.toUpperCase()} `,password)).card.name,user.name);
  for(let i=0;i<5;i++)await assert.rejects(service.login(user.email,"wrong"),{status:401,message:"ელფოსტა ან პაროლი არასწორია"});
  await assert.rejects(service.login(user.email,password),{status:429});
  assert.equal(JSON.stringify((await read()).accounts),before);
});
test("six users receive unique cards, repeated/concurrent clicks retain results and another-device login restores them",async t=>{
  const {path,service,read}=await setup(t);const users: Awaited<ReturnType<typeof enroll>>[]=[];
  for(const name of PARTICIPANTS)users.push(await enroll(service,name));
  assert.equal((await read()).drawnAt,null);
  const results=await Promise.all(Array.from({length:60},(_,i)=>new SantaService(path).reveal(users[i%6].token)));
  const recipients=[];
  for(const user of users){
    const own=results.filter(r=>r.name===user.name);own.forEach(r=>assert.deepEqual(r,own[0]));
    assert.notEqual(own[0].recipientName,user.name);recipients.push(own[0].recipientName!);
    const second=await service.login(user.email,password);assert.deepEqual(second.card,own[0]);
  }
  assert.deepEqual(recipients.sort(),[...PARTICIPANTS].sort());
  const raw=await readFile(path,"utf8");await Promise.all(users.map(u=>service.reveal(u.token)));assert.equal(await readFile(path,"utf8"),raw);
});
test("legacy accounts and assignments survive initialization and first-mode checks",async t=>{
  const {path,service,read}=await setup(t);const user=await enroll(service);const card=await service.reveal(user.token);
  const before=await read();await new SantaService(path).initialize();
  assert.deepEqual(await read(),before);
  assert.deepEqual(await service.startSetup(user.name,user.email),{mode:"login"});
  const after=await read();assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.assignments,before.assignments);
  assert.deepEqual((await service.login(user.email,password)).card,card);
});
test("old name-only rounds gain inactive accounts without losing pairings or openings",async t=>{
  const {path,service,read}=await setup(t);
  const legacy={version:1,drawnAt:"2026-11-20T00:00:00.000Z",assignments:PARTICIPANTS.map((name,i)=>({name,recipientName:PARTICIPANTS[(i+1)%6],openedAt:"2026-11-21T00:00:00.000Z"}))};
  await (new SantaService(path)).initialize();await writeFile(path,JSON.stringify(legacy));
  const user=await enroll(service);
  assert.deepEqual((await read()).assignments,legacy.assignments);
  assert.equal(user.card.recipientName,PARTICIPANTS[1]);
});
test("only a login session can access cards, and logout invalidates it",async t=>{
  const {path,service}=await setup(t);const user=await enroll(service);const api=apiFor(path);
  assert.equal((await api.get("","?name=გიორგი")).status,401);
  assert.equal((await api.post({action:"reveal",name:user.name})).status,401);
  assert.equal((await api.post({action:"login",email:user.email,password},"","http://attacker.test")).status,403);
  const response=await api.post({action:"login",email:user.email,password});const session=responseCookie(response,cookieName());
  const card=await api.post({action:"reveal",name:"ანა"},session);assert.equal((await card.json()).name,user.name);
  assert.equal((await api.post({action:"logout"},session)).status,200);assert.equal((await api.get(session)).status,401);
  assert.equal((await api.post({action:"activate",name:user.name,email:user.email,password})).status,400);
});
test("new Node process preserves sessions, passwords, and revealed results",async t=>{
  const {path,service}=await setup(t);const user=await enroll(service);const expected=await service.reveal(user.token);const raw=await readFile(path,"utf8");
  const script=`import { SantaService } from ${JSON.stringify(pathToFileURL(resolve("lib/santa.ts")).href)};process.stdout.write(JSON.stringify(await new SantaService(process.argv[1]).status(process.argv[2])));`;
  const {stdout}=await promisify(execFile)(process.execPath,["--conditions=react-server","--import","tsx","--input-type=module","-e",script,path,user.token]);
  assert.deepEqual(JSON.parse(stdout),expected);assert.equal(await readFile(path,"utf8"),raw);
});
test("invalid JSON is logged safely and never replaced with a new draw",async t=>{
  const {path,service}=await setup(t);await service.initialize();await writeFile(path,"{ PRIVATE_DATA");
  const log=t.mock.method(console,"error",()=>{});
  await assert.rejects(service.initialize());assert.equal(await readFile(path,"utf8"),"{ PRIVATE_DATA");
  assert.deepEqual(log.mock.calls[0].arguments,["[secret-santa] storage error",{kind:"corrupt"}]);
});
