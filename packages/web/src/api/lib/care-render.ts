import { RESEND_LINE, isLoopPile, isWoolFibre } from "./care-codes";

/* ---------------------------------------------------------------------------
 * Putting a care email together. Pure, no imports beyond the codes, so the
 * real send and the Care page preview use exactly the same thing.
 *
 * The look is a personal note from Damien: no banner, no buttons, no logo.
 * The only picture is the T5 video thumbnail. An invisible 1 pixel image at the
 * end tells us it was opened, which the resend rule needs.
 * ------------------------------------------------------------------------- */

export const CARE_SIGNOFF = ["Damien", "Terra Flooring | 1300 183 772"] as const;

export const T5_VIDEO_URL = "https://www.youtube.com/watch?v=cpbeEDWa3Uw";
export const T5_VIDEO_HTML = `<a href="${T5_VIDEO_URL}"><img src="https://i.ytimg.com/vi/cpbeEDWa3Uw/hqdefault.jpg" alt="Tony Riddle, Lose the Shoes (watch on YouTube)" width="480" style="max-width:100%;border-radius:8px;"></a>`;

export interface CareFlags {
  fibre: string;
  pile: string;
}

/** One {if ...} test. "Wool" covers wool blend too, as the spec says. */
function test(cond: string, f: CareFlags) {
  return cond
    .split(/\s+or\s+/i)
    .map((c) => c.trim().toLowerCase())
    .some((c) => {
      if (c === "wool" || c === "wool blend") return isWoolFibre(f.fibre);
      if (c === "loop pile" || c === "loop") return isLoopPile(f.pile);
      return false;
    });
}

/**
 * Keeps or drops each {if ...} ... {/if} block, inline or across lines, then
 * tidies the gaps a dropped block leaves behind.
 */
export function applyConditions(body: string, f: CareFlags) {
  let out = body;
  for (let i = 0; i < 20 && /\{if [^}]+\}/i.test(out); i++) {
    out = out.replace(/\{if ([^}]+)\}((?:(?!\{if )[\s\S])*?)\{\/if\}/gi, (_m, cond: string, inner: string) => (test(cond, f) ? inner.trim() : ""));
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** **bold**, [text](url) and bare links. Escapes first, so nothing in the copy can inject markup. */
function inline(raw: string) {
  const links: string[] = [];
  let s = raw.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) => {
    links.push(`<a href="${esc(url)}" style="color:#1a5fb4;">${esc(text)}</a>`);
    return `\uE000${links.length - 1}\uE000`;
  });
  s = s.replace(/https?:\/\/[^\s<)]+/g, (whole) => {
    // A full stop or comma after a link is the sentence, not the link.
    const url = whole.replace(/[.,;:!?]+$/, "");
    links.push(`<a href="${esc(url)}" style="color:#1a5fb4;">${esc(url)}</a>`);
    return `\uE000${links.length - 1}\uE000${whole.slice(url.length)}`;
  });
  s = esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => links[Number(i)] ?? "");
}

const P = 'style="margin:0 0 14px;"';

/** One paragraph block to HTML: lists, numbered lists, checklists and the quote box. */
function block(text: string) {
  if (text.trim() === "{video}") return `<p ${P}>${T5_VIDEO_HTML}</p>`;
  const lines = text.split("\n");
  if (lines.every((l) => /^>\s?/.test(l))) {
    const inner = lines.map((l) => inline(l.replace(/^>\s?/, ""))).join("<br>");
    return `<div style="margin:0 0 14px;padding:12px 14px;border-left:4px solid #b5651d;background:#fbf3ea;border-radius:4px;">${inner}</div>`;
  }
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol" | "check"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p ${P}>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    if (list.type === "check") {
      out.push(`<ul style="margin:0 0 14px;padding-left:4px;list-style:none;">${list.items.map((i) => `<li style="margin:0 0 6px;">${inline(i)}</li>`).join("")}</ul>`);
    } else {
      const tag = list.type;
      out.push(`<${tag} style="margin:0 0 14px;padding-left:22px;">${list.items.map((i) => `<li style="margin:0 0 6px;">${inline(i)}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };
  for (const l of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(l);
    const num = /^\s*\d+\.\s+(.*)$/.exec(l);
    if (bullet || num) {
      flushPara();
      const item = (bullet ?? num)![1]!;
      const type = num ? "ol" : item.startsWith("☐") ? "check" : "ul";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(item);
    } else {
      flushList();
      para.push(l);
    }
  }
  flushPara();
  flushList();
  return out.join("");
}

/** Markdown-ish copy to the plain-text twin. */
export function careBodyText(body: string) {
  return body
    .replace(/^\{video\}$/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CareRenderOpts {
  unsubUrl: string;
  /** The open pixel. Left out in the preview. */
  pixelUrl?: string;
}

/** The finished email from a body that already had its conditions and merge fields filled. */
export function renderCareEmail(body: string, o: CareRenderOpts) {
  const blocks = body.split(/\n{2,}/).filter((b) => b.trim());
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:600px;padding:16px 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222222;">
${blocks.map(block).join("\n")}
<p style="margin:22px 0 14px;">${CARE_SIGNOFF.map(esc).join("<br>")}</p>
<p style="margin:18px 0 0;font-size:12px;color:#888888;font-style:italic;">You're getting this because we installed your floor. <a href="${esc(o.unsubUrl)}" style="color:#888888;">Unsubscribe</a>, no hard feelings.</p>
${o.pixelUrl ? `<img src="${esc(o.pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">` : ""}
</div>
</body></html>`;
  const text = `${careBodyText(body)}\n\n${CARE_SIGNOFF.join("\n")}\n\nYou're getting this because we installed your floor. Unsubscribe: ${o.unsubUrl} (no hard feelings).\n`;
  return { html, text };
}

/** The body to send: conditions applied, and the resend line on top when it is the second go. */
export function careBody(templateBody: string, f: CareFlags, resend = false) {
  const body = applyConditions(templateBody, f);
  if (!resend) return body;
  /* After a short greeting line ("Hey Sarah,") it reads naturally, otherwise on top. */
  const [first, ...rest] = body.split(/\n{2}/);
  if (first && rest.length && /^(hey|hi|heya|hello|g'day)\b[^\n]{0,40},$/i.test(first.trim())) return [first, RESEND_LINE, ...rest].join("\n\n");
  return `${RESEND_LINE}\n\n${body}`;
}
