import { generateText } from "ai";
import dedent from "dedent";
import { gateway } from "./gateway";

/**
 * The only AI in the hands-free crew features: wording the "running late" text
 * to a site contact. Everything Siri reads out comes straight from the
 * database. Siri gives an intent about ten seconds, so the model gets four and
 * a plain template takes over if it is slow or says something odd.
 */

/** Curly quotes and long dashes push a text out of GSM-7, which triples the part count. */
export function gsmSafe(s: string) {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, ",")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lateTemplate(a: { firstName: string; installerFirst: string; minutes: number; place: string }) {
  const hi = a.firstName ? `Hi ${a.firstName}, ` : "Hi, ";
  return `${hi}${a.installerFirst} from Terra Flooring here. I'm running about ${a.minutes} minutes late to ${a.place}. Sorry for the wait.`;
}

export async function draftLateText(a: {
  firstName: string;
  installerFirst: string;
  minutes: number;
  place: string;
}): Promise<{ body: string; drafted: "ai" | "template" }> {
  const fallback = lateTemplate(a);
  try {
    const r = await generateText({
      model: gateway("openai/gpt-5.4-mini"),
      abortSignal: AbortSignal.timeout(4000),
      prompt: dedent`
        Write one SMS from a flooring installer to the customer's site contact.
        Installer first name: ${a.installerFirst}. Business: Terra Flooring.
        Site contact first name: ${a.firstName || "(unknown, just say Hi)"}.
        Running about ${a.minutes} minutes late to: ${a.place}.
        Rules: under 150 characters, friendly and plain, Australian English,
        say the number of minutes exactly, no emoji, no dashes, no sign off
        beyond the name, do not promise anything else. Reply with the SMS only.
      `,
    });
    const body = gsmSafe(r.text).replace(/^"|"$/g, "");
    if (body.length < 20 || body.length > 200 || !body.includes(String(a.minutes))) {
      return { body: fallback, drafted: "template" };
    }
    return { body, drafted: "ai" };
  } catch {
    return { body: fallback, drafted: "template" };
  }
}
