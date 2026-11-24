"use client";
import { useEffect, useRef, useState } from "react";
import type { CardStatus } from "@/lib/card";

const fieldClass = "mt-2 w-full rounded-xl border border-[#dce2d7] bg-[#fcfdf9] p-3 outline-none focus:border-[#668354] focus:ring-2 focus:ring-[#668354]/20 disabled:opacity-60";
export default function Home() {
  const [card, setCard] = useState<CardStatus | null>(null);
  const [activation, setActivation] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function restore() {
      // Remove the obsolete name-only browser selection; identity now comes from the HttpOnly cookie.
      try { sessionStorage.removeItem("secret-santa.selected-name"); } catch { /* Storage is optional. */ }
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const activationToken = fragment.get("activate");
      await Promise.resolve();
      if (!active) return;
      if (activationToken !== null) {
        setActivation(activationToken || "invalid"); setLoading(false);
        return;
      }
      try {
        const response = await fetch("/api/santa", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!active) return;
        if (response.ok) setCard(data);
        else if (response.status !== 401) setError(data.error);
      } catch { if (active) setError("კავშირი ვერ დამყარდა. სცადე ხელახლა."); }
      finally { if (active) setLoading(false); }
    }
    void restore();
    return () => { active = false; controller.abort(); };
  }, []);

  async function submit(action: "activate" | "login" | "reveal" | "logout") {
    if (pending.current || (action === "reveal" && (!card || card.openedAt))) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const credentials = action === "activate" ? { token: activation, name, email, password } : action === "login" ? { email, password } : {};
      const response = await fetch("/api/santa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...credentials }), cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error);
        if (response.status === 401 && action === "reveal") setCard(null);
        return;
      }
      setPassword("");
      if (action === "logout") { setCard(null); setEmail(""); setName(""); setHidden(false); }
      else { setCard(data); setHidden(false); }
      if (action === "activate") {
        setActivation(""); setName(""); setEmail("");
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    } catch { setError("კავშირი გაწყდა. სცადე ხელახლა — შენახული შედეგი არ შეიცვლება."); }
    finally { pending.current = false; setBusy(false); }
  }
  function leaveActivation() {
    setActivation(""); setName(""); setPassword(""); setEmail(""); setError("");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10">
      <section aria-label="Secret Santa" className="w-full max-w-md rounded-3xl border border-[#e0e4db] bg-white p-6 shadow-[0_12px_50px_#293d2010] sm:p-8">
        {loading ? <p role="status" className="text-center text-sm text-[#617065]">იტვირთება…</p> : !card ? (
          <form onSubmit={event => { event.preventDefault(); void submit(activation ? "activate" : "login"); }} className="space-y-5">
            <h1 className="text-xl font-bold">{activation ? "ანგარიშის გააქტიურება" : "შესვლა"}</h1>
            {activation && <label htmlFor="name" className="block text-sm font-medium">სახელი<input id="name" name="name" required maxLength={80} autoComplete="name" value={name} onChange={event => setName(event.target.value)} disabled={busy} className={fieldClass} /></label>}
            <label htmlFor="email" className="block text-sm font-medium">ელფოსტა<input id="email" name="email" type="email" required maxLength={254} autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} className={fieldClass} /></label>
            <label htmlFor="password" className="block text-sm font-medium">{activation ? "ახალი პაროლი" : "პაროლი"}<input id="password" name="password" type="password" required minLength={activation ? 10 : undefined} maxLength={128} autoComplete={activation ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} className={fieldClass} /></label>
            {activation && <p className="text-xs leading-6 text-[#617065]">გამოიყენე 10–128 სიმბოლო. ეს ბმული მხოლოდ ერთხელ გააქტიურდება.</p>}
            <button type="submit" className="primary" disabled={busy}>{busy ? "მუშავდება…" : activation ? "გააქტიურება" : "შესვლა"}</button>
            {activation && <button type="button" disabled={busy} onClick={leaveActivation} className="w-full p-2 text-sm text-[#516453]">შესვლის გვერდზე დაბრუნება</button>}
          </form>
        ) : (
          <div className="text-center">
            <h1 className="mb-5 text-xl font-bold">შენი საიდუმლო ბარათი</h1>
            {card.recipientName ? hidden ? <button className="primary" type="button" onClick={() => setHidden(false)}>შედეგის ჩვენება</button> : <p role="status" className="rounded-2xl border border-[#d0dec5] bg-[#eef4e8] p-6 text-sm leading-8">შენ საჩუქარს უმზადებ: <strong className="block break-words text-2xl text-[#284b38]">{card.recipientName}</strong></p> : (
              <>
                <div aria-hidden="true" className="relative mx-auto my-8 flex h-48 max-w-xs items-end justify-center rounded-b-[70px] border-b-[18px] border-[#b78a55] bg-[#f5eddc] pb-6">
                  <span className="-rotate-12 rounded-xl bg-[#819b6c] px-5 py-9 text-3xl text-white shadow-md">✳</span><span className="-ml-5 mb-3 rotate-6 rounded-xl bg-[#284b38] px-5 py-9 text-3xl text-white shadow-md">✳</span><span className="-ml-5 rotate-12 rounded-xl bg-[#c49968] px-5 py-9 text-3xl text-white shadow-md">✳</span>
                </div>
                <button type="button" className="primary" disabled={busy} onClick={() => void submit("reveal")}>{busy ? "ბარათი იხსნება…" : "კალათიდან ამოღება"}</button>
              </>
            )}
            {card.recipientName && !hidden && <button type="button" onClick={() => setHidden(true)} className="mt-5 w-full rounded-xl border border-[#c7d2c0] p-3 text-sm text-[#516453]">შედეგის დამალვა</button>}
            <button type="button" disabled={busy} onClick={() => void submit("logout")} className="mt-5 w-full rounded-xl border border-[#c7d2c0] p-3 text-sm text-[#516453] disabled:opacity-60">გასვლა</button>
          </div>
        )}
        {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm leading-7 text-red-800">{error}</p>}
      </section>
    </main>
  );
}
