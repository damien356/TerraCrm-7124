import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { DELIVERY, isDeliveryText } from "../lib/line-kinds";
import { siteGuessFromText } from "../lib/site-guess";
import { newSiteInput } from "../lib/job-new-records";
import { fillJobFromQuote } from "../lib/quote-convert";
import { quoteRefOf } from "../lib/quote-number";
import { jobRef } from "../lib/job-ref";
import { pushToInstaller } from "../lib/push";

/* ---------------------------------------------------------------------------
 * 188001 list item 12: site is blank. A quote with a delivery line and no
 * site asks for one before Send and Accept, and a job with no site offers
 * "No site. Add one". Both use the same form, prefilled from the delivery
 * line's text.
 * ------------------------------------------------------------------------- */

/** Quotes that can still take a site. Accepted and the rest are shut. */
const OPEN_QUOTE = ["draft", "needs_review", "sent"];

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

/** Tasks the crew is booked on and still has to turn up for. */
const BOOKED = ["assigned", "in_progress"];

type SiteRow = typeof schema.sites.$inferSelect;
/** "14 Smith Street, Nerang QLD 4211": the one line used in the log, the push and PO delivery. */
const siteLine = (s: Pick<SiteRow, "address" | "suburb" | "state" | "postcode">) =>
  [s.address, [s.suburb, s.state, s.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/**
 * What a change of address touches on this job, so the office sees it before
 * saving: other jobs at the same site, booked crew, POs, and the paperwork
 * that keeps the address it was issued with.
 */
async function changeScope(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  if (!job.siteId) throw bad("This job has no site yet. Use Add one.");
  const [site] = await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId));
  if (!site) throw bad("This job's site is gone. Use Add one.");

  const [otherJobs, crew, pos, swms] = await Promise.all([
    db
      .select({ id: schema.jobs.id, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber, title: schema.jobs.title })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.siteId, site.id), ne(schema.jobs.id, job.id)))
      .orderBy(desc(schema.jobs.id)),
    db
      .select({ taskId: schema.jobTasks.id, jobId: schema.jobTasks.jobId, title: schema.jobTasks.title, installerId: schema.installers.id, name: schema.installers.name })
      .from(schema.jobTasks)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .where(and(eq(schema.jobs.siteId, site.id), inArray(schema.jobTasks.status, BOOKED))),
    db
      .select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, jobId: schema.purchaseOrders.jobId })
      .from(schema.purchaseOrders)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.purchaseOrders.jobId))
      .where(and(eq(schema.jobs.siteId, site.id), eq(schema.purchaseOrders.deliverTo, "site"), inArray(schema.purchaseOrders.status, ["draft", "sent"]))),
    db.select({ id: schema.swmsRecords.id, jobId: schema.swmsRecords.jobId }).from(schema.swmsRecords).innerJoin(schema.jobs, eq(schema.jobs.id, schema.swmsRecords.jobId)).where(eq(schema.jobs.siteId, site.id)),
  ]);
  return { job, site, otherJobs, crew, pos, swms };
}

type DeliveryLine = { kind: string; description: string };
const isDeliveryLine = (i: DeliveryLine) => i.kind === DELIVERY || isDeliveryText(i.description);

/** The first delivery line's text on these quotes, newest first. */
async function deliveryTextOf(quoteIds: number[]) {
  if (!quoteIds.length) return null;
  const items = await db
    .select({ quoteId: schema.quoteItems.quoteId, kind: schema.quoteItems.kind, description: schema.quoteItems.description })
    .from(schema.quoteItems)
    .where(inArray(schema.quoteItems.quoteId, quoteIds))
    .orderBy(schema.quoteItems.sortOrder, schema.quoteItems.id);
  for (const id of quoteIds) {
    const line = items.find((i) => i.quoteId === id && isDeliveryLine(i));
    if (line) return line.description;
  }
  return null;
}

function answer(needed: boolean, deliveryText: string | null) {
  return {
    needed,
    /** The delivery line the guess came from, shown above the form. */
    deliveryText,
    guess: deliveryText ? siteGuessFromText(deliveryText) : null,
  };
}

export const siteFill = {
  /** Needed when the quote has a delivery line and neither it nor its job has a site. */
  forQuote: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, input.quoteId));
    if (!quote) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
    const [job] = quote.jobId ? await db.select({ siteId: schema.jobs.siteId }).from(schema.jobs).where(eq(schema.jobs.id, quote.jobId)) : [];
    const text = await deliveryTextOf([quote.id]);
    return answer(!!text && !quote.siteId && !job?.siteId, text);
  }),

  /** Needed when the job has no site. The guess comes off its newest quote with a delivery line. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const [job] = await db.select({ siteId: schema.jobs.siteId }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    if (job.siteId) return answer(false, null);
    const quotes = await db
      .select({ id: schema.quotes.id })
      .from(schema.quotes)
      .where(eq(schema.quotes.jobId, input.jobId))
      .orderBy(desc(schema.quotes.version), desc(schema.quotes.id));
    return answer(true, await deliveryTextOf(quotes.map((q) => q.id)));
  }),

  /**
   * Save the site on the quote and its job, or on the job and its open
   * quotes. Either an existing site (siteId) or a new address (newSite).
   */
  save: staffOnly
    .input(
      z.object({
        quoteId: z.number().optional(),
        jobId: z.number().optional(),
        siteId: z.number().optional(),
        newSite: newSiteInput.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (!input.quoteId === !input.jobId) throw bad("Save the site on a quote or on a job.");
      if (!input.siteId === !input.newSite) throw bad("Pick an existing site or type a new address.");

      const [quote] = input.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, input.quoteId)) : [];
      if (input.quoteId && !quote) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
      const jobId = quote ? quote.jobId : input.jobId!;
      const [job] = jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)) : [];
      if (input.jobId && !job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

      if (quote && !OPEN_QUOTE.includes(quote.status)) throw bad("This quote is locked. Add the site on the job page.");
      if (quote?.siteId) throw bad("This quote already has a site.");
      if (job?.siteId) throw bad("This job already has a site.");

      let site: typeof schema.sites.$inferSelect | undefined;
      if (input.siteId) {
        [site] = await db.select().from(schema.sites).where(eq(schema.sites.id, input.siteId));
        if (!site) throw bad("That site is gone. Pick it again.");
      } else {
        [site] = await db
          .insert(schema.sites)
          .values({
            ...input.newSite!,
            contactId: quote?.contactId ?? job?.contactId ?? null,
            companyId: quote?.companyId ?? job?.companyId ?? null,
          })
          .returning();
      }
      const s = site!;

      if (quote) {
        await db.update(schema.quotes).set({ siteId: s.id, updatedAt: new Date() }).where(eq(schema.quotes.id, quote.id));
        // The job takes the site, its access notes and the address as title (lib/quote-convert.ts).
        if (quote.jobId) await fillJobFromQuote(quote.id);
      } else if (job) {
        const patch: Partial<typeof schema.jobs.$inferInsert> = { siteId: s.id, updatedAt: new Date() };
        if (!job.accessNotes && s.accessNotes) patch.accessNotes = s.accessNotes;
        if (/^Quote Q\d/.test(job.title ?? "")) patch.title = s.address;
        await db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, job.id));
        // Its quotes that can still change take the site too. Accepted ones stay as signed.
        await db
          .update(schema.quotes)
          .set({ siteId: s.id, updatedAt: new Date() })
          .where(and(eq(schema.quotes.jobId, job.id), isNull(schema.quotes.siteId), inArray(schema.quotes.status, OPEN_QUOTE)));
      }

      const where = [s.address, s.suburb].filter(Boolean).join(", ");
      await db.insert(schema.activityLog).values({
        jobId: jobId ?? null,
        contactId: quote?.contactId ?? job?.contactId ?? null,
        entityType: quote ? "quote" : "job",
        entityId: quote ? quote.id : job!.id,
        action: "site_added",
        detail: quote ? `Site ${where} added to quote ${await quoteRefOf(quote)}` : `Site ${where} added to the job`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { siteId: s.id, address: s.address, suburb: s.suburb };
    }),

  /** What changing this job's address would touch. Shown in the Change form before saving. */
  changeInfo: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const { job, site, otherJobs, crew, pos, swms } = await changeScope(input.jobId);
    const here = (r: { jobId: number }) => r.jobId === job.id;
    return {
      site: { id: site.id, address: site.address, suburb: site.suburb, state: site.state, postcode: site.postcode, propertyType: site.propertyType, lat: site.lat, lng: site.lng, placeId: site.placeId, geoSource: site.geoSource },
      otherJobs: otherJobs.map((j) => ({ id: j.id, ref: jobRef(j), title: j.title })),
      /** Crew booked at this site, on this job and (for a correction) the others. */
      crew: crew.map((c) => ({ taskId: c.taskId, jobId: c.jobId, installerId: c.installerId, name: c.name, thisJob: here(c) })),
      sentPos: pos.filter((p) => p.status === "sent").map((p) => ({ number: p.number, thisJob: here(p) })),
      draftPos: pos.filter((p) => p.status === "draft").map((p) => ({ number: p.number, thisJob: here(p) })),
      swmsThisJob: swms.filter(here).length,
      swmsAll: swms.length,
    };
  }),

  /**
   * Change the address on a job that already has a site.
   * fix: the same place, typed wrong. The site itself is corrected, so every job there changes.
   * move: this job is somewhere else. It moves to another site (picked or new); other jobs keep the old one.
   * Open quotes and draft site POs follow. Sent POs, signed SWMS, issued invoices and accepted
   * quotes keep the address they went out with. Booked crew can be told in the app.
   */
  change: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        scope: z.enum(["fix", "move"]),
        siteId: z.number().optional(),
        newSite: newSiteInput.optional(),
        tellCrew: z.boolean().default(true),
      }),
    )
    .handler(async ({ input, context }) => {
      const { job, site: old, otherJobs } = await changeScope(input.jobId);
      if (!input.siteId === !input.newSite) throw bad("Pick an existing site or type the address.");
      if (input.scope === "fix" && input.siteId) throw bad("To use another site, choose that this job is at a different address.");
      if (input.siteId === old.id) throw bad("That is the site this job already has.");
      if (input.scope === "move" && input.newSite && siteLine(input.newSite) === siteLine(old)) {
        throw bad("That is the address this job already has. To fix its details, choose Correct this address.");
      }

      let next: SiteRow | undefined;
      if (input.scope === "fix") {
        const n = input.newSite!;
        const moved = n.address !== old.address || n.suburb !== old.suburb || n.state !== old.state || (n.postcode ?? null) !== (old.postcode ?? null);
        const pinned = n.geoSource === "google";
        const newPin = pinned && (n.lat !== old.lat || n.lng !== old.lng);
        if (!moved && !newPin && n.propertyType === old.propertyType) throw bad("Nothing has changed. Edit the address, then save.");
        // A new pick brings its pin. Typing over the address drops the old pin, so Navigate is not sent to the wrong place.
        const googlePin = { lat: n.lat, lng: n.lng, placeId: n.placeId, geoSource: "google" };
        const geo = newPin ? googlePin : moved ? { lat: null, lng: null, placeId: null, geoSource: "" } : {};
        [next] = await db
          .update(schema.sites)
          .set({ address: n.address, suburb: n.suburb, state: n.state, postcode: n.postcode ?? null, propertyType: n.propertyType, ...geo, updatedAt: new Date() })
          .where(eq(schema.sites.id, old.id))
          .returning();
      } else if (input.siteId) {
        [next] = await db.select().from(schema.sites).where(eq(schema.sites.id, input.siteId));
        if (!next) throw bad("That site is gone. Pick it again.");
      } else {
        [next] = await db
          .insert(schema.sites)
          .values({ ...input.newSite!, contactId: job.contactId ?? null, companyId: job.companyId ?? null })
          .returning();
      }
      const s = next!;
      const from = siteLine(old);
      const to = siteLine(s);

      // The jobs that now read the new address: all of them at the site on a fix, just this one on a move.
      const touched = input.scope === "fix" ? [{ id: job.id, number: job.number, displayNumber: job.displayNumber, title: job.title }, ...otherJobs] : [job];
      const ids = touched.map((j) => j.id);

      if (input.scope === "move") {
        const patch: Partial<typeof schema.jobs.$inferInsert> = { siteId: s.id, updatedAt: new Date() };
        if (!job.accessNotes && s.accessNotes) patch.accessNotes = s.accessNotes;
        await db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, job.id));
        // Its quotes that can still change move too. Accepted ones stay as signed.
        await db
          .update(schema.quotes)
          .set({ siteId: s.id, updatedAt: new Date() })
          .where(and(eq(schema.quotes.jobId, job.id), eq(schema.quotes.siteId, old.id), inArray(schema.quotes.status, OPEN_QUOTE)));
      }
      // A title that was just the street address follows it.
      for (const j of touched) {
        if (old.address && (j.title ?? "").trim() === old.address.trim() && s.address !== old.address) {
          await db.update(schema.jobs).set({ title: s.address, updatedAt: new Date() }).where(eq(schema.jobs.id, j.id));
        }
      }
      // Draft POs to site have not gone to the supplier: they take the new address.
      const draftPos = await db
        .update(schema.purchaseOrders)
        .set({ deliveryAddress: to, updatedAt: new Date() })
        .where(and(inArray(schema.purchaseOrders.jobId, ids), eq(schema.purchaseOrders.deliverTo, "site"), eq(schema.purchaseOrders.status, "draft")))
        .returning({ number: schema.purchaseOrders.number });
      const sentPos = await db
        .select({ number: schema.purchaseOrders.number })
        .from(schema.purchaseOrders)
        .where(and(inArray(schema.purchaseOrders.jobId, ids), eq(schema.purchaseOrders.deliverTo, "site"), eq(schema.purchaseOrders.status, "sent")));

      for (const j of touched) {
        const how = input.scope === "fix" ? (j.id === job.id ? "corrected" : `corrected from job ${jobRef(job)}`) : "changed, job moved to a different site";
        const tail = sentPos.length && j.id === job.id ? ` Sent POs keep the old delivery address: ${sentPos.map((p) => p.number).join(", ")}.` : "";
        await db.insert(schema.activityLog).values({
          jobId: j.id,
          contactId: job.contactId ?? null,
          entityType: "job",
          entityId: j.id,
          action: "site_changed",
          detail: `Site address ${how}: ${from || "(blank)"} → ${to}.${tail}`,
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });
      }

      // Crew last, once the database has the new address.
      let crewTold = 0;
      if (input.tellCrew && to !== from) {
        const crew = await db
          .select({ taskId: schema.jobTasks.id, jobId: schema.jobTasks.jobId, installerId: schema.jobTasks.assignedInstallerId })
          .from(schema.jobTasks)
          .where(and(inArray(schema.jobTasks.jobId, ids), inArray(schema.jobTasks.status, BOOKED)));
        const told = new Set<string>();
        for (const c of crew) {
          if (!c.installerId) continue;
          const key = `${c.installerId}:${c.jobId}`;
          if (told.has(key)) continue;
          told.add(key);
          const j = touched.find((t) => t.id === c.jobId)!;
          const sent = await pushToInstaller(c.installerId, {
            title: `New address: job ${jobRef(j)}`,
            body: `The site is now ${to}. Check the job before you go.`,
            data: { kind: "task", taskId: c.taskId, jobId: c.jobId },
          }).catch((e) => {
            console.error("[site-change] crew push failed:", e);
            return 0;
          });
          if (sent > 0) crewTold++;
        }
      }

      return {
        siteId: s.id,
        address: s.address,
        suburb: s.suburb,
        jobsChanged: ids.length,
        draftPosUpdated: draftPos.map((p) => p.number),
        sentPosKeptOld: sentPos.map((p) => p.number),
        crewTold,
      };
    }),
};
