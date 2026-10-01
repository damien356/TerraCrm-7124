import { generateObject } from "ai";
import { z } from "zod";
import dedent from "dedent";
import { gateway } from "./gateway";

/**
 * Pass 1 of the voice quote pipeline: turn a raw transcript into structured
 * lines. This model never sees the price book (4,000+ products). It only
 * knows the fixed, small labour rate book (under 90 items), so it can match a
 * labour item directly. Materials come back as spoken hints (supplier,
 * range, colour...) and get matched against the products table in code,
 * in `price.ts`, where a fuzzy match can be scored and a bad one flagged.
 */

/**
 * OpenAI's structured-output mode rejects `oneOf` (zod discriminated unions
 * compile to that), so this is one flat object with every field optional and
 * a `kind` tag to say which fields actually apply. `price.ts` reads `kind`
 * and only looks at the matching fields.
 */
export const extractionLineSchema = z.object({
  kind: z.enum(["material", "labour", "other"]),

  // material fields
  spokenDescription: z.string().nullable().describe("What Damien actually said for this line, verbatim-ish. Material lines only."),
  unit: z.enum(["m2", "lm", "each"]).nullable().describe("Material lines only."),
  category: z
    .enum(["carpet", "carpet_tile", "vinyl", "hybrid", "laminate", "timber", "underlay", "accessory", "unknown"])
    .nullable()
    .describe("Material lines only."),
  supplierHint: z.string().nullable().describe("Supplier name if mentioned, e.g. 'Godfrey Hirst'. Material lines only."),
  brandHint: z.string().nullable().describe("Material lines only."),
  rangeHint: z.string().nullable().describe("Product range/collection name if mentioned. Material lines only."),
  colourHint: z.string().nullable().describe("Material lines only."),

  // labour fields
  labourItemId: z.number().nullable().describe("The id of the matching item from the labour rate book given below. Labour lines only."),
  note: z.string().nullable().describe("Labour lines only."),

  // other fields
  description: z.string().nullable().describe("Plain description of the line, e.g. 'Furniture moving'. Other lines only."),
  spokenDollarAmount: z
    .number()
    .nullable()
    .describe("The dollar figure Damien spoke for this, taken as the COST before markup. Other lines only."),

  // shared
  qty: z.number().positive().describe("Quantity for material/labour lines, or count for other lines (default 1)."),
});

export const extractionSchema = z.object({
  customerSpokenName: z
    .string()
    .nullable()
    .describe("The customer or company name Damien mentioned, if any. Null if he named none."),
  customerIsNew: z.boolean().describe("True when Damien says it is a new client or customer."),
  customerMobile: z.string().nullable().describe("The customer's phone number if said, digits only, e.g. 0400003003."),
  customerEmail: z.string().nullable().describe("The customer's email if said, e.g. janedoe@gmail.com."),
  customerAddress: z.string().nullable().describe("Street address of the job or customer if said, without the suburb."),
  customerSuburb: z.string().nullable().describe("Suburb if said."),
  lines: z.array(extractionLineSchema),
  generalNotes: z
    .string()
    .nullable()
    .describe("Anything Damien said that is relevant but does not fit a line: access issues, timing, etc."),
});

export type Extraction = z.infer<typeof extractionSchema>;

export async function extractVoiceQuote(
  transcript: string,
  labourItems: { id: number; name: string; groupName: string; unit: string }[],
) {
  const labourList = labourItems
    .map((i) => `${i.id}: ${i.name} (${i.groupName}, per ${i.unit})`)
    .join("\n");

  const { object } = await generateObject({
    model: gateway("openai/gpt-5.4"),
    schema: extractionSchema,
    prompt: dedent`
      You are turning a flooring installer's spoken job note into structured quote
      lines for Terra Flooring. Damien dictates a rough quote on site: materials,
      install labour, and sometimes a flat dollar figure for something like moving
      furniture. Break his transcript into lines.

      Rules:
      - A material line is a flooring product (carpet, vinyl, underlay, etc) sold by
        the price book. Capture whatever supplier/brand/range/colour he mentions as
        hints. Do not invent one he did not say.
      - A labour line is installation work. Match it to the CLOSEST item in the
        labour rate book below by id. If he says "stairs" with no further detail,
        prefer the standard straight step item unless he clearly means winders.
        "Winders" and "winder" always mean the winder step item, never straight
        stairs and never a window.
      - A line with a spoken dollar figure that is not a price-book item (e.g.
        "furniture shift, call it $150" or "moving furniture, say 200 bucks") is
        "other", with that figure as spokenDollarAmount. Never treat this as a
        labour line even if a "Furniture shift" item exists in the rate book.
      - Quantities are numbers, not words: "forty lineal metres" is qty 40, unit "lm".
      - If he names a customer or company, put it in customerSpokenName exactly as
        said. Otherwise null. Any phone number, email, street address or suburb he
        gives for the customer goes in the customer fields, not in generalNotes.
        Emails are spoken: "jane doe at gmail dot com" is janedoe@gmail.com.

      Labour rate book (id: name (group, unit)):
      ${labourList}

      Transcript:
      """
      ${transcript}
      """
    `,
  });

  return object;
}
