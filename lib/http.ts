import { SantaError, SESSION_SECONDS, type SantaService } from "./santa";
import { validToken } from "./password";
export const cookieName = () => process.env.NODE_ENV === "production" ? "__Host-santa_session" : "santa_session";
function sessionToken(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName()}=`))?.slice(cookieName().length + 1);
  return validToken(value) ? value : undefined;
}
export function reply(body: unknown, status = 200, token?: string | null) {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store", "Vary": "Cookie", "Referrer-Policy": "no-referrer" };
  if (token !== undefined) headers["Set-Cookie"] = `${cookieName()}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
  return Response.json(body, { status, headers });
}
export async function handle(request: Request, getService: () => SantaService) {
  try {
    const token = sessionToken(request);
    if (request.method === "GET") return reply(await getService().status(token));
    if (request.method !== "POST") return reply({ error: "მოთხოვნა დაუშვებელია." }, 405);
    if (request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "მოთხოვნა დაუშვებელია." }, 403);
    const raw = await request.text();
    if (raw.length > 4096) return reply({ error: "მოთხოვნა ზედმეტად დიდია." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return reply({ error: "არასწორი მოთხოვნა." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "არასწორი მოთხოვნა." }, 400);
    if (body.action === "activate") {
      const result = await getService().activate(body);
      return reply(result.card, 200, result.token);
    }
    if (body.action === "login") {
      const result = await getService().login(body.email, body.password);
      return reply(result.card, 200, result.token);
    }
    if (body.action === "logout") { await getService().logout(token); return reply({ ok: true }, 200, null); }
    if (body.action === "status") return reply(await getService().status(token));
    if (body.action === "reveal") return reply(await getService().reveal(token));
    return reply({ error: "არასწორი მოთხოვნა." }, 400);
  } catch (error) {
    if (error instanceof SantaError) return reply({ error: error.message }, error.status);
    return reply({ error: "შენახულ მონაცემებზე წვდომა ვერ დასრულდა. სცადე ხელახლა — შენი შედეგი არ შეიცვლება." }, 503);
  }
}
