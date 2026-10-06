import { generateObject } from "ai";
import { z } from "zod";
import { gateway } from "./gateway";
import { cleanWording, lineForPrompt, STYLE_SAMPLE } from "../lib/bundles";

export type WordingInput = {
  title: string;
  lines: { kind: string; description: string; productCategory: string | null }[];
  /** Quote notes: rooms, access, site details. */
  notes: string | null;
  /** What the person asked for this time, e.g. "mention the stairs are open riser". */
  hint?: string | null;
  /** The wording as it stands, when rewriting. */
  current?: string | null;
};

export function wordingPrompt(input: WordingInput): string {
  return [
    "You write the scope wording for one section of a Terra Flooring quote. The client sees only this wording and one total for the section.",
    "",
    "Rules:",
    "- Plain Australian English, in the style of the sample below. Start with \"To supply and install\" when the section has a floor product.",
    "- Name each product as brand and range, with the colour in quotes where known. If no colour is given, write (colour to be advised).",
    "- Mention rooms or areas only if the lines or notes name them. Never invent rooms.",
    "- Cover stairs, underlay, preparation, removal and disposal when the lines include them.",
    "- NEVER state quantities, square metres, lineal metres, step counts, rates or prices. Thickness in mm is fine.",
    "- Never use em dashes or en dashes. Use commas and full stops.",
    "- No headings, no bullet points, no sign off. One or two short paragraphs.",
    "- Do not promise anything the lines do not include.",
    "",
    "Style sample:",
    `"""${STYLE_SAMPLE}"""`,
    "",
    `Section: ${input.title}`,
    "Lines in this section:",
    ...input.lines.map(lineForPrompt),
    input.notes?.trim() ? `\nQuote notes:\n"""${input.notes.trim()}"""` : "",
    input.current?.trim() ? `\nCurrent wording (rewrite it):\n"""${input.current.trim()}"""` : "",
    input.hint?.trim()
      ? `\nThe user asked: "${input.hint.trim()}"\nFollow that for what to stress and how to say it, but the lines above decide the work. If it mentions work that is not in the lines (uplift, removal, stairs, prep), leave that work out.`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export async function draftBundleWording(input: WordingInput): Promise<string> {
  const { object } = await generateObject({
    model: gateway("openai/gpt-5.4"),
    schema: z.object({ wording: z.string().describe("The section wording, ready for the client.") }),
    prompt: wordingPrompt(input),
  });
  return cleanWording(object.wording);
}
