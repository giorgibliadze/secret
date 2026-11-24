// Explicit integration check against an isolated private Blob namespace. Never changes production accounts.
import { loadEnvConfig } from "@next/env";
import { get, put, del } from "@vercel/blob";
import assert from "node:assert/strict";
import { BlobJsonDriver } from "../lib/storage/blob";
import { JsonStorage } from "../lib/storage/transaction";
import { SantaService } from "../lib/santa";
import { handle, cookieName, setupCookieName } from "../lib/http";
import { ACCOUNT_EMAILS } from "../lib/accounts";
import { digest } from "../lib/password";

let checkpoint = "configuration";
const TEST_PASSWORD = "Verification-Only-Password-2026!";
async function main() {
  loadEnvConfig(process.cwd());
  const args = process.argv.slice(2);
  const phase = args[args.indexOf("--phase") + 1];
  const run = args[args.indexOf("--run") + 1];
  if (!["before", "after", "cleanup"].includes(phase) || !/^[a-zA-Z0-9-]{8,64}$/.test(run ?? "")) throw new Error("Use --phase before|after --run unique-run-id");
  const statePath = `secret-santa-verification/${run}/state.json`;
  const baselinePath = `secret-santa-verification/${run}/baseline.json`;
  const service = () => new SantaService(new JsonStorage(new BlobJsonDriver(statePath)));
  const read = async (path: string) => {
    checkpoint = "private-blob-read";
    const response = await get(path, { access: "private", useCache: false, headers: { "accept-encoding": "identity" } });
    if (response === null) return null;
    if (response.statusCode !== 200 || !response.stream) throw new Error("Unexpected test Blob response");
    return { value: JSON.parse(await new Response(response.stream).text()), etag: response.blob.etag };
  };
  const post = (body: unknown, cookie = "") => handle(new Request("https://verification.invalid/api/santa", { method: "POST", headers: { origin: "https://verification.invalid", cookie }, body: JSON.stringify(body) }), service);
  const cookie = (response: Response, name: string) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))!.split(";")[0];
  const fingerprint = (state: { accounts: { password: unknown }[]; drawnAt: unknown; assignments: unknown }) => digest(JSON.stringify({ password: state.accounts[0].password, drawnAt: state.drawnAt, assignments: state.assignments }));
  if (phase === "cleanup") {
    for (const path of [statePath, baselinePath]) {
      const saved = await read(path);
      if (saved) { checkpoint = "private-blob-cleanup"; await del(path, { ifMatch: saved.etag }); }
    }
    console.log("Isolated verification artifacts cleaned.");
    return;
  }
  if (phase === "before") {
    checkpoint = "empty-test-namespace";
    assert.equal(await read(statePath), null, "Verification run already exists");
    checkpoint = "mismatched-identity";
    const mismatch = await post({ action: "startSetup", name: "გიორგი", email: ACCOUNT_EMAILS["ანა"] });
    assert.equal(mismatch.status, 400);
    checkpoint = "first-setup";
    const first = await post({ action: "startSetup", name: "გიორგი", email: ACCOUNT_EMAILS["გიორგი"] });
    assert.equal(first.status, 200);
    checkpoint = "set-password";
    const active = await post({ action: "setPassword", password: TEST_PASSWORD }, cookie(first, setupCookieName()));
    assert.equal(active.status, 200);
    checkpoint = "activation-session-cookie";
    const session = cookie(active, cookieName());
    checkpoint = "double-reveal";
    const cards = await Promise.all([post({ action: "reveal" }, session), post({ action: "reveal" }, session)]);
    const card = await cards[0].json(); assert.ok(card.recipientName); assert.ok(card.openedAt);
    assert.deepEqual(await cards[1].json(), card);
    checkpoint = "wrong-password";
    assert.equal((await post({ action: "login", email: ACCOUNT_EMAILS["გიორგი"], password: "wrong" })).status, 401);
    assert.equal((await post({ action: "logout" }, session)).status, 200);
    checkpoint = "repeat-login";
    const login = await post({ action: "login", email: ACCOUNT_EMAILS["გიორგი"], password: TEST_PASSWORD });
    assert.equal(login.status, 200); assert.deepEqual(await login.json(), card);
    checkpoint = "read-saved-state";
    const state = (await read(statePath))!;
    await put(baselinePath, JSON.stringify({ card, fingerprint: fingerprint(state.value) }), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json" });
    console.log("Private Blob live verification passed: first setup, password, double reveal, wrong password, and repeat login. Redeploy persistence baseline saved in an isolated test namespace.");
  } else {
    const baseline = await read(baselinePath);
    if (!baseline) {
      assert.equal(await read(statePath), null, "Incomplete verification state");
      console.log("Verification artifacts already cleaned by a previous successful redeploy check.");
      return;
    }
    checkpoint = "repeat-login";
    const login = await post({ action: "login", email: ACCOUNT_EMAILS["გიორგი"], password: TEST_PASSWORD });
    assert.equal(login.status, 200); assert.deepEqual(await login.json(), baseline.value.card);
    const card = await post({ action: "reveal" }, cookie(login, cookieName()));
    assert.deepEqual(await card.json(), baseline.value.card);
    checkpoint = "read-saved-state";
    const state = (await read(statePath))!;
    assert.equal(fingerprint(state.value), baseline.value.fingerprint, "Password/draw/opening time changed across deployments");
    assert.equal(new Set(state.value.assignments.map((a: { recipientName: string }) => a.recipientName)).size, 6);
    assert.ok(state.value.assignments.every((a: { name: string; recipientName: string }) => a.name !== a.recipientName));
    await del(statePath, { ifMatch: state.etag });
    await del(baselinePath, { ifMatch: baseline.etag });
    console.log("Private Blob redeploy verification passed: saved password hash, draw and opening time survived. Isolated test artifacts removed; production accounts were not modified.");
  }
}
void main().catch((error: unknown) => {
  const failure = error as { name?: string; constructor?: { name?: string }; message?: string; actual?: unknown; expected?: unknown };
  const safeReason = failure.message?.match(/No blob credentials found|Failed to fetch blob: [0-9]{3} [A-Za-z ]+|Invalid token: unable to extract store ID|Unexpected test Blob response|Use --phase before\|after --run unique-run-id/)?.[0];
  console.error("Private Blob live verification failed; production accounts were not reset.", {
    checkpoint, errorType: failure.constructor?.name, ...(safeReason ? { reason: safeReason } : {}), kind: /^[A-Za-z]+$/.test(failure.name ?? "") ? failure.name : "Error",
    ...(typeof failure.actual === "number" ? { actualStatus: failure.actual } : {}),
    ...(typeof failure.expected === "number" ? { expectedStatus: failure.expected } : {}),
  });
  process.exitCode = 1;
});
