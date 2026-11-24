"use client";
import { useEffect, useRef, useState } from "react";
import type { CardStatus } from "@/lib/card";
const selectionKey = "secret-santa.selected-name";
export default function Home() {
  const [name, setName] = useState("");
  const [card, setCard] = useState<CardStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const current = version.current;
    let saved = "";
    try { saved = sessionStorage.getItem(selectionKey) ?? ""; } catch { /* Storage is optional. */ }
    if (!saved) return;
    async function restore() {
      try {
        const response = await fetch("/api/santa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", name: saved }), cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!active || current !== version.current) return;
        if (response.ok) { setName(data.name); setCard(data); }
        else { setError(data.error); if (response.status === 404) { try { sessionStorage.removeItem(selectionKey); } catch {} } }
      } catch { if (active && current === version.current) setError("კავშირი ვერ დამყარდა. შეიყვანე სახელი და სცადე ხელახლა."); }
    }
    void restore();
    return () => { active = false; controller.abort(); };
  }, []);

  async function submit(action: "status" | "reveal") {
    if (pending.current || (action === "reveal" && (!card || card.openedAt))) return;
    pending.current = true;
    const current = ++version.current;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/santa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, name: action === "status" ? name.trim().normalize("NFC") : card!.name }), cache: "no-store" });
      const data = await response.json();
      if (current !== version.current) return;
      if (response.ok) {
        setCard(data); setName(data.name);
        try { sessionStorage.setItem(selectionKey, data.name); } catch { /* Storage is optional. */ }
      } else setError(data.error);
    } catch { if (current === version.current) setError("კავშირი გაწყდა. სცადე ხელახლა — შედეგი არ შეიცვლება."); }
    finally { pending.current = false; if (current === version.current) setBusy(false); }
  }
  function hide() {
    version.current++;
    setCard(null); setName(""); setError(""); setBusy(false);
    try { sessionStorage.removeItem(selectionKey); } catch { /* Storage is optional. */ }
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10">
      <section aria-label="Secret Santa" className="w-full max-w-md rounded-3xl border border-[#e0e4db] bg-white p-6 shadow-[0_12px_50px_#293d2010] sm:p-8">
        {!card ? (
          <form onSubmit={event => { event.preventDefault(); void submit("status"); }} autoComplete="off" className="space-y-5">
            <label htmlFor="participant" className="block text-sm font-medium">შეიყვანე შენი სახელი</label>
            <input id="participant" name="participant" type="text" value={name} maxLength={80} autoComplete="off" autoCorrect="off" spellCheck={false} disabled={busy} onChange={event => { version.current++; setName(event.target.value); setError(""); }} className="w-full rounded-xl border border-[#dce2d7] bg-[#fcfdf9] p-3 outline-none focus:border-[#668354] focus:ring-2 focus:ring-[#668354]/20 disabled:opacity-60" />
            <button type="submit" className="primary" disabled={busy}>{busy ? "მოწმდება…" : "გაგრძელება"}</button>
          </form>
        ) : (
          <div className="text-center">
            {card.recipientName ? (
              <p role="status" className="break-words rounded-2xl border border-[#d0dec5] bg-[#eef4e8] p-8 text-3xl font-bold text-[#284b38]">{card.recipientName}</p>
            ) : (
              <>
                <div aria-hidden="true" className="relative mx-auto my-8 flex h-48 max-w-xs items-end justify-center rounded-b-[70px] border-b-[18px] border-[#b78a55] bg-[#f5eddc] pb-6">
                  <span className="-rotate-12 rounded-xl bg-[#819b6c] px-5 py-9 text-3xl text-white shadow-md">✳</span><span className="-ml-5 mb-3 rotate-6 rounded-xl bg-[#284b38] px-5 py-9 text-3xl text-white shadow-md">✳</span><span className="-ml-5 rotate-12 rounded-xl bg-[#c49968] px-5 py-9 text-3xl text-white shadow-md">✳</span>
                </div>
                <button type="button" className="primary" disabled={busy} onClick={() => void submit("reveal")}>{busy ? "ბარათი იხსნება…" : "კალათიდან ამოღება"}</button>
              </>
            )}
            <button type="button" onClick={hide} className="mt-5 w-full rounded-xl border border-[#c7d2c0] p-3 text-sm text-[#516453] hover:bg-[#f0f3ea] focus-visible:outline-2 focus-visible:outline-offset-2">შედეგის დამალვა</button>
          </div>
        )}
        {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm leading-7 text-red-800">{error}</p>}
      </section>
    </main>
  );
}
