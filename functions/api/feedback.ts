// Cloudflare Pages Function — POST /api/feedback
// Emails site feedback to datum@javcon.io via Resend. The webapp is a static
// SPA, so this server-side endpoint holds the API key (RESEND_API_KEY, set in
// the CF Pages project env) and is the only thing that can send mail.
//
// Question feedback requires a return email (so we can reply); compliments and
// complaints may be anonymous. The submitted screen/url context is included so
// we know where the user was.
interface Env {
  RESEND_API_KEY: string;
}

// `from` must be on a domain verified in Resend (javcon.io).
const FROM = "DATUM Feedback <feedback@javcon.io>";
const TYPES: Record<string, string> = { question: "Question", compliment: "Compliment", complaint: "Complaint" };
// Route each intent to its own inbox (all currently forward to the same place,
// but this keeps them pre-categorized and independently re-routable).
const TO_BY_TYPE: Record<string, string> = {
  question: "feedback@javcon.io",
  compliment: "complement@javcon.io",
  complaint: "complain@javcon.io",
};

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

  const type = String(body.type ?? "");
  const message = String(body.message ?? "").trim();
  const email = String(body.email ?? "").trim();
  const screen = String(body.screen ?? "").slice(0, 200);
  const title = String(body.title ?? "").slice(0, 200);
  const url = String(body.url ?? "").slice(0, 500);

  if (!TYPES[type]) return json({ error: "invalid type" }, 400);
  if (!message) return json({ error: "message is required" }, 400);
  if (message.length > 5000) return json({ error: "message too long" }, 400);
  // Questions need a way to reply; compliments/complaints may be anonymous.
  if (type === "question" && !isEmail(email)) return json({ error: "a return email is required for questions" }, 400);
  if (email && !isEmail(email)) return json({ error: "invalid email" }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "email is not configured" }, 503);

  const label = TYPES[type];
  const subject = `[DATUM ${label}] ${screen || "webapp"}`;
  const text = [
    `Type:   ${label}`,
    `Screen: ${title || screen}${url ? `  (${url})` : ""}`,
    `From:   ${email || "(anonymous)"}`,
    "",
    message,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO_BY_TYPE[type]], subject, text, ...(email ? { reply_to: email } : {}) }),
  });
  if (!res.ok) return json({ error: "could not send — please email datum@javcon.io directly" }, 502);
  return json({ ok: true });
};
