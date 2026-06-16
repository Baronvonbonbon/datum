// Cloudflare Pages Function — POST /api/subscribe
// "Register interest" capture. Emails the signup to datum@javcon.io via Resend
// (the list is managed manually for now). Same RESEND_API_KEY / verified
// javcon.io sender as /api/feedback.
interface Env {
  RESEND_API_KEY: string;
}

const LIST_TO = "datum@javcon.io";
const FROM = "DATUM Signups <feedback@javcon.io>";

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const email = String(body.email ?? "").trim();
  const name = String(body.name ?? "").trim().slice(0, 120);
  const source = String(body.source ?? "").slice(0, 200);

  if (!isEmail(email)) return json({ error: "a valid email is required" }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "signups are not configured" }, 503);

  const text = [
    `New interest registration`,
    `Email:  ${email}`,
    name ? `Name:   ${name}` : null,
    source ? `Source: ${source}` : null,
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [LIST_TO], subject: `[DATUM] New interest: ${email}`, text, reply_to: email }),
  });
  if (!res.ok) return json({ error: "could not register — please email datum@javcon.io directly" }, 502);
  return json({ ok: true });
};
