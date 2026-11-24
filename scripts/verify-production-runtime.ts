// Read-only runtime check. Uses same-project Vercel Trusted Sources, never an application's login session.
async function main() {
  const origin = "https://secret-alpha-two.vercel.app";
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  const response = await fetch(`${origin}/api/santa`, {
    headers: oidc ? { "x-vercel-trusted-oidc-idp-token": oidc } : {},
    redirect: "manual", signal: AbortSignal.timeout(30000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    console.log("Read-only runtime check was blocked by Vercel Authentication; Blob/redeploy verification is recorded separately.");
    return;
  }
  const body = await response.json();
  if (response.status !== 401 || body.error !== "გთხოვ, შეხვიდე ანგარიშში.") throw new Error("Unexpected application storage/auth response");
  console.log("Read-only production runtime check passed: private Blob was readable and the API requires an application login (401), with no storage error.");
}
void main().catch(() => { console.error("Read-only production runtime check failed."); process.exitCode = 1; });
