import { MARKETING_FROM, sendEmail } from "./email";
import { MailboxNotConnected, SEND_FROM, sendFromTeam, type OutgoingMail } from "./gmail";

/**
 * Every email the agent sends goes out as team@. Nothing else.
 *
 * Through team@'s own Gmail when it is connected, so the email sits in team@'s
 * Sent folder like one a person typed. If team@ is not connected yet it goes
 * through the existing mail service, still from team@ with replies to team@.
 * There is no way to pass a different sender into this function.
 */
export async function sendAsTeam(mail: OutgoingMail): Promise<{ via: "gmail" | "relay"; id: string }> {
  try {
    const r = await sendFromTeam(mail);
    return { via: "gmail", id: r.id };
  } catch (e) {
    if (!(e instanceof MailboxNotConnected)) throw e;
  }
  if (!MARKETING_FROM.includes(SEND_FROM)) throw new Error("Relay sender is not team@, refusing to send");
  const out = await sendEmail({
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(mail.text)}</div>`,
    from: MARKETING_FROM,
    replyTo: SEND_FROM,
    attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
  });
  if (!out.ok) throw new Error(out.reason);
  return { via: "relay", id: out.providerId };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
