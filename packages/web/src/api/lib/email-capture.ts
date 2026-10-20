import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * Test runs only (notes 18.65). When EMAIL_CAPTURE_DIR is set, every email is
 * written to that folder instead of being sent: one JSON file per email plus
 * its attachments beside it. Nothing reaches Resend or Gmail. Production never
 * sets this, so it changes nothing there.
 * ------------------------------------------------------------------------- */

export const captureDir = () => (process.env.EMAIL_CAPTURE_DIR ?? "").trim() || null;

export type Captured = {
  via: string;
  from?: string;
  to: string;
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

/** Writes the email to the capture folder. Returns its id, or null when capture is off. */
export function captureEmail(mail: Captured): string | null {
  const dir = captureDir();
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const id = `mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const files = (mail.attachments ?? []).map((a, i) => {
    const name = `${id}-${i}-${a.filename.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    writeFileSync(join(dir, name), a.content);
    return { filename: a.filename, savedAs: name, bytes: a.content.length };
  });
  const record = { id, at: new Date().toISOString(), via: mail.via, from: mail.from ?? null, to: mail.to, cc: mail.cc ?? [], subject: mail.subject, text: mail.text ?? "", html: mail.html ?? "", attachments: files };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  return id;
}
