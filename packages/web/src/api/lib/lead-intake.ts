import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { createJob } from "../routes/jobs";
import { addressFromComponents } from "../routes/places";
import { findMatches, phoneKey, emailKey } from "./contact-merge";
import { notifyOffice } from "./notify";
import { normaliseMobile } from "./sms";
import { putObject, mediaKey } from "./s3";
import { EMAIL_RE } from "./quote-email";
import { sendAsTeam } from "./agent-mail";
import { LEAD_AUTOREPLY_KEY, clientTypeLabel, repairTypeOf, floorTypeOf, TIMBER_TAG, repairTypeLabel, floorTypeLabel } from "./lead-codes";
import { startRepairRequest } from "./timber-repair";

/* ---------------------------------------------------------------------------
 * LANDING PAGE FORMS COMING IN (spec 14 Oct, Part A item 3). Section 18.38.
 *
 * Every page posts to /api/leads/<form key>. The key finds the page in
 * Settings, Leads, and the page decides the lead source, client type, tags
 * and whether Marc prices it. A page added there needs no code change here.
 *
 * Each page still sends its own fields, named its own way (fullName, name,
 * contactName; phone, mobile; practiceName, pharmacyName, businessName...).
 * FIELD_ALIASES reads them all. Anything not known goes on the job too, under
 * its own name, so no answer is ever dropped.
 *
 * Spam never makes a job. It is kept in lead_submissions with the reason.
 * ------------------------------------------------------------------------- */

export type LeadFile = { name: string; type: string; bytes: Buffer };

/** releaseId: a blocked post Damien let through in Settings. Skips the spam and twice checks. */
export type LeadMeta = { ip: string; userAgent?: string; origin?: string; now?: Date; releaseId?: number };

/** Field names the pages use, folded to lower case letters and digits only. */
const FIELD_ALIASES: Record<string, string[]> = {
  name: ["name", "fullname", "contactname", "yourname", "clientname", "customername"],
  firstName: ["firstname", "first", "givenname"],
  lastName: ["lastname", "last", "surname", "familyname"],
  phone: ["phone", "mobile", "phonenumber", "mobilenumber", "tel", "telephone", "contactnumber", "mobilephone"],
  email: ["email", "emailaddress", "youremail", "contactemail"],
  business: ["businessname", "practicename", "pharmacyname", "company", "companyname", "business", "clinicname", "organisation", "organization", "venue", "venuename"],
  address: ["address", "siteaddress", "location", "street", "streetaddress", "propertyaddress", "fulladdress", "projectaddress"],
  suburb: ["suburb", "city", "town", "locality"],
  postcode: ["postcode", "postalcode", "zip"],
  state: ["state"],
  practiceType: ["practicetype", "businesstype", "clinictype"],
  stage: ["projectstage", "stage", "timeframe", "timing", "when"],
  flooring: ["flooringtype", "flooring", "producttype", "currentflooring", "projecttype", "floorwanted"],
  floorType: ["floortype", "typeoffloor", "timbertype"],
  size: ["m2", "sqm", "area", "floorarea", "size", "kitchensize", "approxarea", "squaremetres", "squaremeters", "areasize", "damagedarea", "damagesize"],
  repairType: ["repairtype", "damagetype", "typeofdamage", "repair"],
  message: ["message", "details", "notes", "comments", "comment", "enquiry", "description", "moredetails"],
  gclid: ["gclid"],
  gbraid: ["gbraid"],
  wbraid: ["wbraid"],
  pageUrl: ["pageurl", "page", "landingpage", "referrer", "sourceurl"],
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];

/** Hidden trap fields a person never fills in, and the "form opened at" stamp. */
const HONEYPOTS = ["_hp", "hp", "honeypot", "botfield", "_gotcha", "websiteurl", "faxnumber"];
const STARTED_KEYS = ["_t", "_started", "formstartedat", "_elapsed"];
/** Our own bookkeeping fields, never shown as an answer. */
const META_KEYS = new Set(["formkey", "_key", "key", "photos", "photourls", "files", "consent", "privacy", "agree", "recaptcha", "grecaptcharesponse", "role", "submit", "photokeys", "formlocation"]);

const fold = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

const LABELS: Record<string, string> = {
  practiceType: "Practice type",
  stage: "Project stage",
  flooring: "Flooring",
  floorType: "Floor type",
  size: "Area (m2)",
  repairType: "Repair type",
  business: "Business name",
  message: "Message",
};

/** Turn "kitchenSize" or "floor_age" into "Kitchen size" / "Floor age". */
function prettyLabel(k: string) {
  const s = k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : k;
}

export type ReadLead = {
  name: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  business: string;
  address: string;
  suburb: string;
  postcode: string;
  state: string;
  repairType: string;
  floorType: string;
  size: string;
  message: string;
  gclid: string;
  utm: Record<string, string>;
  /** Every answer in the order it reads best, as label and value. */
  answers: Array<[string, string]>;
  honeypot: boolean;
  startedAt: number | null;
  photoUrls: string[];
};

const asText = (v: unknown): string => {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(", ");
  if (typeof v === "object") return "";
  return String(v).split(String.fromCharCode(0)).join("").trim().slice(0, 4000);
};

/** Read whatever shape the page sent into one lead. */
export function readLeadFields(raw: Record<string, unknown>): ReadLead {
  const byFold = new Map<string, { key: string; value: unknown }>();
  for (const [k, v] of Object.entries(raw)) byFold.set(fold(k), { key: k, value: v });
  const used = new Set<string>();
  const pick = (field: string) => {
    for (const a of FIELD_ALIASES[field] ?? []) {
      const hit = byFold.get(a);
      if (hit && asText(hit.value)) {
        used.add(a);
        return asText(hit.value);
      }
    }
    return "";
  };
  const out = {
    name: pick("name"),
    firstName: pick("firstName"),
    lastName: pick("lastName"),
    phone: pick("phone"),
    email: pick("email").toLowerCase(),
    business: pick("business"),
    address: pick("address"),
    suburb: pick("suburb"),
    postcode: pick("postcode"),
    state: pick("state"),
    practiceType: pick("practiceType"),
    stage: pick("stage"),
    flooring: pick("flooring"),
    floorType: pick("floorType"),
    size: pick("size"),
    repairType: pick("repairType"),
    message: pick("message"),
    gclid: pick("gclid"),
    gbraid: pick("gbraid"),
    wbraid: pick("wbraid"),
    pageUrl: pick("pageUrl"),
  };
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = asText(byFold.get(fold(k))?.value);
    if (v) utm[k] = v.slice(0, 300);
    used.add(fold(k));
  }
  if (out.gbraid) utm.gbraid = out.gbraid;
  if (out.wbraid) utm.wbraid = out.wbraid;
  if (out.pageUrl) utm.page = out.pageUrl.slice(0, 500);

  const honeypot = HONEYPOTS.some((h) => asText(byFold.get(h)?.value) !== "");
  for (const h of HONEYPOTS) used.add(h);
  let startedAt: number | null = null;
  for (const s of STARTED_KEYS) {
    used.add(fold(s));
    const v = Number(asText(byFold.get(fold(s))?.value));
    if (!Number.isFinite(v) || v <= 0) continue;
    // _elapsed is milliseconds the form was open. The rest are a clock time in ms.
    startedAt = s === "_elapsed" ? -v : v;
  }

  const answers: Array<[string, string]> = [];
  const add = (label: string, v: string) => v && answers.push([label, v]);
  add(LABELS.business!, out.business);
  add(LABELS.practiceType!, out.practiceType);
  add(LABELS.repairType!, out.repairType);
  add(LABELS.stage!, out.stage);
  add(LABELS.flooring!, out.flooring);
  add(LABELS.floorType!, out.floorType);
  add(LABELS.size!, out.size);
  // Anything else the page sent, under its own name.
  for (const [f, { key, value }] of byFold) {
    if (used.has(f) || META_KEYS.has(f) || f.startsWith("utm")) continue;
    if (Object.values(FIELD_ALIASES).some((list) => list.includes(f))) continue;
    if (key.startsWith("_")) continue;
    const v = asText(value);
    if (v) add(prettyLabel(key), v);
  }
  add(LABELS.message!, out.message);

  const photoRaw = byFold.get("photourls")?.value ?? byFold.get("photos")?.value;
  const photoUrls = (Array.isArray(photoRaw) ? photoRaw : typeof photoRaw === "string" && photoRaw.trim() ? photoRaw.split(/[\s,]+/) : [])
    .map((u) => (typeof u === "string" ? u : typeof u === "object" && u && "url" in u ? String((u as { url: unknown }).url) : ""))
    .filter((u) => /^https:\/\//i.test(u))
    .slice(0, 10);

  return {
    name: out.name,
    firstName: out.firstName,
    lastName: out.lastName,
    phone: out.phone,
    email: out.email,
    business: out.business,
    address: out.address,
    suburb: out.suburb,
    postcode: out.postcode,
    state: out.state,
    repairType: out.repairType,
    floorType: out.floorType || out.flooring,
    size: out.size,
    message: out.message,
    gclid: out.gclid.slice(0, 300),
    utm,
    answers,
    honeypot,
    startedAt,
    photoUrls,
  };
}

/** Looks like a street address: a number then a street word. Used only to flag, never to guess. */
const STREET_RE = /\b\d{1,5}[a-z]?\s*[/,-]?\s*\d{0,5}\s+[a-z][a-z' ]{1,40}\s(st|street|rd|road|ave|avenue|dr|drive|ct|court|cres|crescent|pde|parade|pl|place|tce|terrace|hwy|highway|blvd|boulevard|way|lane|ln|cl|close|cct|circuit|esp|esplanade)\b/i;

const MIN_FILL_MS = 3000;
const RATE_PER_HOUR = 8;
const DUPLICATE_MINUTES = 15;

/** Why this post is junk, or null when it reads like a person. */
export function spamReason(lead: ReadLead, now: number): string | null {
  if (lead.honeypot) return "Hidden trap field was filled in";
  if (lead.startedAt != null) {
    const ms = lead.startedAt < 0 ? -lead.startedAt : now - lead.startedAt;
    if (ms >= 0 && ms < MIN_FILL_MS) return "Sent too fast to be a person";
  }
  const digits = lead.phone.replace(/\D/g, "");
  const phoneOk = digits.length >= 8 && digits.length <= 12 && !/^(\d)\1+$/.test(digits);
  const emailOk = EMAIL_RE.test(lead.email);
  if (!phoneOk && !emailOk) return "No phone or email that works";
  const text = `${lead.name} ${lead.message} ${lead.business}`;
  if ((text.match(/https?:\/\//gi) ?? []).length >= 3) return "Message is full of links";
  if (/[Ѐ-ӿ一-鿿]{6,}/.test(text)) return "Message is not in English";
  if (/\b(seo|backlinks?|crypto|casino|viagra|loan offer|web design services)\b/i.test(text)) return "Reads like a sales pitch";
  return null;
}

/** Name into first and last. "Dr Sarah Lee" stays "Dr Sarah" + "Lee". */
function splitName(lead: ReadLead) {
  if (lead.firstName || lead.lastName) return { first: lead.firstName || lead.lastName, last: lead.firstName ? lead.lastName : "" };
  const parts = lead.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1]! };
}

type Place = { address: string; suburb: string; state: string; postcode: string; lat: number; lng: number; placeId: string };

/** Google's best match for a typed street address, only when it found the house. */
export async function lookUpAddress(text: string): Promise<Place | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || !text.trim()) return null;
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.formattedAddress,places.location,places.addressComponents",
      },
      body: JSON.stringify({ textQuery: text, regionCode: "au", languageCode: "en-AU", pageSize: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { places?: any[] };
    const p = j.places?.[0];
    if (!p?.location) return null;
    const parts = p.addressComponents ?? [];
    if (!parts.some((x: any) => x.types?.includes("street_number"))) return null;
    const a = addressFromComponents(parts, String(p.formattedAddress ?? text));
    return {
      address: a.address,
      suburb: a.suburb,
      state: a.state || "QLD",
      postcode: a.postcode,
      lat: Number(p.location.latitude),
      lng: Number(p.location.longitude),
      placeId: String(p.id ?? ""),
    };
  } catch {
    return null;
  }
}

const COMPANY_TYPE_FOR: Record<string, (typeof schema.companies.$inferInsert)["type"]> = {
  healthcare: "commercial",
  commercial: "commercial",
  builder: "builder",
  homeowner: "other",
};

export type LeadOutcome =
  | { ok: true; verdict: "ok"; jobId: number; jobNumber: number; submissionId: number; flags: string[]; photos: number; repairRequestId: number | null }
  | { ok: true; verdict: "duplicate"; jobId: number | null; submissionId: number }
  | { ok: true; verdict: "spam"; submissionId: number; reason: string };

/**
 * Take one form post. Never throws for bad input: a page should always get a
 * thank you, and the office sees anything odd as a flag or in the blocked list.
 */
export async function takeLead(formKey: string, raw: Record<string, unknown>, files: LeadFile[], meta: LeadMeta): Promise<LeadOutcome> {
  const now = meta.now ?? new Date();
  const key = String(formKey || asText(raw.formKey) || asText(raw._key) || "").trim().toLowerCase().slice(0, 80);
  const [page] = key
    ? await db.select().from(schema.landingPages).where(and(eq(schema.landingPages.formKey, key), eq(schema.landingPages.active, true)))
    : [];
  const lead = readLeadFields(raw);
  const ip = (meta.ip || "").slice(0, 80);

  const keep = async (verdict: string, reason: string, jobId: number | null = null) => {
    if (meta.releaseId) {
      await db
        .update(schema.leadSubmissions)
        .set({ verdict: "released", jobId, updatedAt: new Date() })
        .where(eq(schema.leadSubmissions.id, meta.releaseId));
      return meta.releaseId;
    }
    const stored = { ...raw };
    for (const k of Object.keys(stored)) if (HONEYPOTS.includes(fold(k)) && !stored[k]) delete stored[k];
    const [row] = await db
      .insert(schema.leadSubmissions)
      .values({
        formKey: key,
        landingPageId: page?.id ?? null,
        raw: JSON.stringify({ ...stored, _files: files.map((f) => `${f.name} (${f.type}, ${f.bytes.length} bytes)`), _ua: meta.userAgent ?? "", _origin: meta.origin ?? "" }).slice(0, 60000),
        verdict,
        reason,
        ip,
        jobId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.leadSubmissions.id });
    return row!.id;
  };

  let reason = meta.releaseId ? null : spamReason(lead, now.getTime());
  if (!reason && ip && !meta.releaseId) {
    const hourAgo = new Date(now.getTime() - 3600_000);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.leadSubmissions)
      .where(and(eq(schema.leadSubmissions.ip, ip), gte(schema.leadSubmissions.createdAt, hourAgo)));
    if (Number(n) >= RATE_PER_HOUR) reason = `More than ${RATE_PER_HOUR} forms from one address in an hour`;
  }
  if (reason) return { ok: true, verdict: "spam", reason, submissionId: await keep("spam", reason) };

  /* The same person pressing Send twice is one lead. */
  const pk = phoneKey(lead.phone);
  const ek = emailKey(lead.email);
  const since = new Date(now.getTime() - DUPLICATE_MINUTES * 60_000);
  const recent = await db
    .select({ raw: schema.leadSubmissions.raw, jobId: schema.leadSubmissions.jobId })
    .from(schema.leadSubmissions)
    .where(and(eq(schema.leadSubmissions.formKey, key), eq(schema.leadSubmissions.verdict, "ok"), gte(schema.leadSubmissions.createdAt, since)));
  for (const r of meta.releaseId ? [] : recent) {
    let prev: ReadLead;
    try {
      prev = readLeadFields(JSON.parse(r.raw) as Record<string, unknown>);
    } catch {
      continue;
    }
    if ((pk && phoneKey(prev.phone) === pk) || (ek && emailKey(prev.email) === ek)) {
      return { ok: true, verdict: "duplicate", jobId: r.jobId, submissionId: await keep("duplicate", "Sent again within 15 minutes", r.jobId) };
    }
  }

  const flags: string[] = [];
  if (!page) flags.push("Unknown landing page");

  /* The person. A match on mobile or email is the same person, a name alone is not. */
  const { first, last } = splitName(lead);
  const mobile = normaliseMobile(lead.phone);
  const landline = mobile ? null : lead.phone || null;
  const matches = await findMatches({ mobile, phone: lead.phone, email: lead.email || null });
  const strong = matches.find((m) => m.reasons.includes("mobile") || m.reasons.includes("email"));
  const sourceName = page?.leadSource || "Website";

  /* The business, only when one was named. An existing card with that name is used. */
  let companyId: number | null = null;
  let newCompany: { name: string; type: (typeof schema.companies.$inferInsert)["type"] } | null = null;
  if (lead.business) {
    const [co] = await db
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(sql`lower(trim(${schema.companies.name})) = ${lead.business.trim().toLowerCase()}`)
      .limit(1);
    if (co) companyId = co.id;
    else newCompany = { name: lead.business.slice(0, 200), type: COMPANY_TYPE_FOR[page?.clientType ?? ""] ?? "other" };
  }

  /* The site. A street address goes through Google. A suburb alone is noted, never made into a site. */
  let newSite: Record<string, unknown> | null = null;
  const typed = [lead.address, lead.suburb && !lead.address.toLowerCase().includes(lead.suburb.toLowerCase()) ? lead.suburb : "", lead.postcode]
    .filter(Boolean)
    .join(" ");
  let suburb = lead.suburb;
  if (lead.address && /\d/.test(lead.address)) {
    const place = await lookUpAddress(typed);
    newSite = place
      ? { address: place.address, suburb: place.suburb, state: place.state, postcode: place.postcode || null, lat: place.lat, lng: place.lng, placeId: place.placeId }
      : { address: lead.address.slice(0, 300), suburb: lead.suburb, state: lead.state || "QLD", postcode: lead.postcode || null };
    newSite.propertyType = page?.clientType === "homeowner" || !page ? "residential" : "commercial";
    if (place?.suburb) suburb = place.suburb;
    if (!place) flags.push("Address not checked with Google");
  } else if (STREET_RE.test(lead.message)) {
    flags.push("Address only in the message");
  } else if (lead.address || lead.suburb) {
    suburb = suburb || lead.address;
    flags.push("Suburb only, no street address");
  } else {
    flags.push("No address");
  }
  if (!first) flags.push("No name given");

  const answersText = lead.answers.map(([l, v]) => `${l}: ${v}`).join("\n");
  const where = suburb ? ` (${suburb})` : "";
  const what = page ? page.leadSource.replace(/^Google Ads:\s*/i, "") : "Website";
  const title = `${what} enquiry${where}`.slice(0, 200);
  const description = [`Landing page enquiry${page ? `: ${page.url}` : ""}.`, answersText, flags.length ? `Flags: ${flags.join(", ")}.` : ""]
    .filter(Boolean)
    .join("\n\n");

  const actor = { name: page ? `Landing page (${page.formKey})` : "Landing page", role: "admin" as const };
  const contactKey = "lead";
  const job = await createJob(
    {
      title,
      description,
      source: sourceName,
      contactId: strong ? strong.contact.id : null,
      contactKey: strong ? null : first || lead.email || lead.phone ? contactKey : null,
      newContacts:
        strong || !(first || lead.email || lead.phone)
          ? []
          : [
              {
                key: contactKey,
                firstName: first || (lead.email ? lead.email.split("@")[0]! : "Enquiry"),
                lastName: last,
                mobile,
                phone: landline,
                email: EMAIL_RE.test(lead.email) ? lead.email : null,
                suburb: suburb || null,
                source: sourceName,
                atCompany: !!(companyId || newCompany),
                companyRole: "other",
                notes: `From the ${page?.url ?? "website"} form.`,
              },
            ],
      companyId,
      newCompany: newCompany as never,
      newSite: newSite as never,
      billToType: companyId || newCompany ? "company" : "contact",
    },
    actor,
  );
  if (!job) throw new Error("The lead job was not made");

  const tags: string[] = [];
  try {
    for (const t of JSON.parse(page?.tags ?? "[]") as unknown[]) if (typeof t === "string" && t.trim()) tags.push(t.trim());
  } catch {
    /* a bad tag list is just no tags */
  }
  const isTimber = !!page?.timber || tags.includes(TIMBER_TAG);
  if (isTimber && !tags.includes(TIMBER_TAG)) tags.push(TIMBER_TAG);
  const repairType = isTimber ? repairTypeOf(lead.repairType || lead.message) : "";
  if (isTimber && !repairType) flags.push("Repair type not picked");

  await db
    .update(schema.jobs)
    .set({
      tags: JSON.stringify(tags),
      landingPageId: page?.id ?? null,
      gclid: lead.gclid,
      utm: Object.keys(lead.utm).length ? JSON.stringify(lead.utm) : "",
      leadFlags: JSON.stringify(flags),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, job.id));

  /* Photos: sent with the form, or links the page already stored. */
  const photoTags = repairType ? [repairTypeLabel(repairType)] : [];
  let photos = 0;
  const all: LeadFile[] = [...files];
  for (const url of lead.photoUrls) {
    if (all.length >= MAX_PHOTOS) break;
    const f = await fetchPhoto(url);
    if (f) all.push(f);
  }
  for (const f of all.slice(0, MAX_PHOTOS)) {
    if (!/^image\//i.test(f.type) || f.bytes.length === 0 || f.bytes.length > MAX_PHOTO_BYTES) continue;
    const storageKey = mediaKey(job.id, "damage", f.name || `photo-${photos + 1}.jpg`);
    try {
      await putObject(storageKey, f.bytes, f.type);
    } catch (e) {
      console.error("[lead-intake] photo not stored", (e as Error).message);
      continue;
    }
    await db.insert(schema.jobMedia).values({
      jobId: job.id,
      bucket: "damage",
      kind: "photo",
      storageKey,
      url: storageKey,
      filename: f.name || null,
      mime: f.type,
      sizeBytes: f.bytes.length,
      caption: photoTags[0] ? `${photoTags[0]}, from the form` : "From the form",
      uploaderName: "Client (form)",
      tags: JSON.stringify(photoTags),
    });
    photos++;
  }
  if (isTimber && photos === 0) {
    flags.push("No photos came with it");
    await db.update(schema.jobs).set({ leadFlags: JSON.stringify(flags) }).where(eq(schema.jobs.id, job.id));
  }

  const submissionId = await keep("ok", "", job.id);

  /* Tell Damien: an office task, a push and the instant email. No SMS, no reply to the client. */
  const who = [`${first} ${last}`.trim(), lead.business].filter(Boolean).join(", ") || "No name";
  const reach = [mobile ?? lead.phone, lead.email].filter(Boolean).join(", ");
  await db.insert(schema.officeTasks).values({
    jobId: job.id,
    title: `Call new lead: ${who} (${what})`.slice(0, 300),
    detail: [reach, suburb, flags.length ? `Flags: ${flags.join(", ")}` : ""].filter(Boolean).join("\n"),
    createdByName: actor.name,
  });
  const clientType = page ? clientTypeLabel(page.clientType) : "";
  await notifyOffice("lead_new", {
    title: `New lead: ${what}`,
    body: [`${who}${reach ? `, ${reach}` : ""}${suburb ? `, ${suburb}` : ""}.`, clientType ? `${clientType}.` : "", flags.length ? `Flags: ${flags.join(", ")}.` : "", answersText]
      .filter(Boolean)
      .join(" ")
      .slice(0, 1800),
    jobId: job.id,
    forceEmail: true,
  });

  /* A short thank you to the client, only when the switch in Settings, Leads is on (off by default). */
  if (EMAIL_RE.test(lead.email)) {
    const [on] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, LEAD_AUTOREPLY_KEY));
    if (on?.value === "1") {
      try {
        await sendAsTeam({ to: lead.email, subject: "Thanks, we got your enquiry", text: autoReplyText(first), fromName: "Terra Flooring" });
        await db.insert(schema.activityLog).values({
          jobId: job.id,
          entityType: "job",
          entityId: job.id,
          action: "lead_autoreply",
          detail: `Thank you email sent to ${lead.email}`,
        });
      } catch (e) {
        console.error("[lead-intake] auto reply not sent", (e as Error).message);
      }
    }
  }

  let repairRequestId: number | null = null;
  if (isTimber) {
    repairRequestId = await startRepairRequest({
      jobId: job.id,
      repairType: repairType || "",
      area: lead.size,
      floorType: floorTypeOf(lead.floorType),
      floorTypeRaw: lead.floorType,
      suburb,
      now,
    });
  }

  return { ok: true, verdict: "ok", jobId: job.id, jobNumber: job.number, submissionId, flags, photos, repairRequestId };
}

/** The client thank you, when switched on. Plain, no promises on price or timing. */
export function autoReplyText(first: string) {
  return [
    `Hi ${first || "there"},`,
    "",
    "Thanks for getting in touch with Terra Flooring. We have your enquiry and one of the team will be in touch soon.",
    "",
    "If it is urgent, call us on 1300 183 772.",
    "",
    "Terra Flooring",
  ].join("\n");
}

export const MAX_PHOTOS = 10;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** A photo the page already uploaded somewhere, fetched once. https only, images only, size capped. */
async function fetchPhoto(url: string): Promise<LeadFile | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!r.ok) return null;
    const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!/^image\//i.test(type)) return null;
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > MAX_PHOTO_BYTES) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES) return null;
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "photo.jpg").slice(-80);
    return { name, type, bytes };
  } catch {
    return null;
  }
}

/** For the report and the Settings blocked list: labels for a floor type. */
export const floorLabel = floorTypeLabel;
