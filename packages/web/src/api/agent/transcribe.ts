import { experimental_transcribe as transcribe } from "ai";
import { openai } from "@ai-sdk/openai";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";

/**
 * Speech to text, direct to OpenAI. The Runable AI Gateway does not proxy
 * transcription models (confirmed 404 on `transcriptionModel`), so this one
 * call uses `OPENAI_API_KEY` directly instead of `gateway`.
 *
 * Model: gpt-4o-transcribe, the same family the ChatGPT app listens with.
 * Tested on Damien's own recordings against whisper-1 (1 Oct 2026):
 *   whisper-1          "New client jdoe0412345678 from Burley"
 *   gpt-4o-transcribe  "New client Jane Doe 0412 345 678 from Burleigh"
 *   whisper-1          "advantaged flooring supplier"
 *   gpt-4o-transcribe  "Advantage Flooring"
 * It is also faster. whisper-1 stays as the fallback if the new model errors.
 *
 * The prompt is a vocabulary hint: suppliers, brands, installers, the suburbs
 * the clients actually live in, and flooring words. Client names are not in
 * it on purpose; those are matched afterwards against the client list with a
 * sounds-alike score (see `lib/memo-context.ts`).
 */

const TRADE_WORDS = [
  "hybrid",
  "laminate",
  "vinyl plank",
  "sheet vinyl",
  "carpet",
  "broadloom",
  "carpet tiles",
  "underlay",
  "timber",
  "engineered oak",
  "stairs",
  "winders",
  "nosing",
  "landing",
  "uplift",
  "floor prep",
  "self levelling",
  "scotia",
  "skirting",
  "trims",
  "square metres",
  "linear metres",
  "dispatch",
  "measure and quote",
];

/* One per database, so the Play reviewer's demo never hears real names and the
 * real memos never pick up demo ones. */
const cache: Record<"live" | "demo", { prompt: string; at: number } | null> = { live: null, demo: null };

async function vocabulary(): Promise<string> {
  const which = inDemo() ? "demo" : "live";
  const cached = cache[which];
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.prompt;
  try {
    const [suppliers, brands, installers, suburbs] = await Promise.all([
      db.select({ name: schema.suppliers.name }).from(schema.suppliers),
      db
        .selectDistinct({ brand: schema.products.brand })
        .from(schema.products)
        .where(and(eq(schema.products.active, true), ne(schema.products.brand, schema.products.supplier))),
      db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.active, true)),
      db
        .select({ suburb: sql<string>`min(${schema.contacts.suburb})` })
        .from(schema.contacts)
        .where(and(isNotNull(schema.contacts.suburb), ne(schema.contacts.suburb, "")))
        .groupBy(sql`lower(${schema.contacts.suburb})`)
        .orderBy(sql`count(*) desc`)
        .limit(30),
    ]);
    const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const list = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x && x.trim())))].join(", ");
    const prompt = [
      "Voice memo for Terra Flooring, a flooring installer on the Gold Coast, Queensland, Australia. Australian English.",
      `Suppliers and brands: ${list([...suppliers.map((s) => s.name), ...brands.map((b) => b.brand)])}.`,
      `Installers: ${list(installers.map((i) => i.name).filter((n) => !/demo/i.test(n)))}.`,
      `Suburbs: ${list(suburbs.map((s) => title(s.suburb)))}.`,
      `Words: ${TRADE_WORDS.join(", ")}.`,
      "Phone numbers are Australian, like 0412 345 678.",
    ].join(" ");
    cache[which] = { prompt, at: Date.now() };
    return prompt;
  } catch (err) {
    console.error("[transcribe] vocabulary lookup failed, carrying on without it", err);
    return "Voice memo for Terra Flooring, a flooring installer on the Gold Coast, Queensland, Australia. Australian English.";
  }
}

/** The new models write American spelling. Damien's customers read Australian. */
export function australianSpelling(text: string) {
  return text
    .replace(/\bcolor(s|ed|ing|ful)?\b/gi, (m, end: string | undefined) => keepCase(m, `colour${end ?? ""}`))
    .replace(/\b(kilo|centi|milli)?meter(s)?\b/gi, (m) => keepCase(m, m.replace(/meter/i, "metre")))
    .replace(/\bcenter(s|ed)?\b/gi, (m, end: string | undefined) => keepCase(m, `centre${end ?? ""}`))
    .replace(/\bgray\b/gi, (m) => keepCase(m, "grey"))
    .replace(/\bfavor(ite|ites|s|ed)?\b/gi, (m, end: string | undefined) => keepCase(m, `favour${end ?? ""}`));
}

function keepCase(original: string, next: string) {
  return original[0] && original[0] === original[0].toUpperCase() ? next[0]!.toUpperCase() + next.slice(1) : next;
}

export async function transcribeAudio(audio: Uint8Array): Promise<string> {
  const prompt = await vocabulary();
  try {
    const result = await transcribe({
      model: openai.transcription("gpt-4o-transcribe"),
      audio,
      providerOptions: { openai: { language: "en", prompt } },
    });
    return australianSpelling(result.text);
  } catch (err) {
    console.error("[transcribe] gpt-4o-transcribe failed, falling back to whisper-1", err);
    const result = await transcribe({
      model: openai.transcription("whisper-1"),
      audio,
      providerOptions: { openai: { language: "en" } },
    });
    return australianSpelling(result.text);
  }
}
