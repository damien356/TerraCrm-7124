import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { auth } from "./auth";
import { bootJourneyEngine } from "./lib/journey-boot";
import { bootOffsiteBackup } from "./lib/offsite-backup-boot";
import { ping, diag, diagThrow, diagActor } from "./routes/ping";
import { settings } from "./routes/settings";
import { contacts } from "./routes/contacts";
import { companies, sites } from "./routes/companies";
import { installers } from "./routes/installers";
import { availability } from "./routes/availability";
import { jobs } from "./routes/jobs";
import { tasks } from "./routes/tasks";
import { offers } from "./routes/offers";
import { quotes } from "./routes/quotes";
import { quoteBundles } from "./routes/quoteBundles";
import { quoteAgent } from "./routes/quoteAgent";
import { field } from "./routes/field";
import { installerInvoices } from "./routes/installerInvoices";
import { upload } from "./routes/upload";
import { areas } from "./routes/areas";
import { media } from "./routes/media";
import { forms } from "./routes/forms";
import { crew } from "./routes/crew";
import { dashboard } from "./routes/dashboard";
import { backups } from "./routes/backups";
import { team } from "./routes/team";
import { suppliers } from "./routes/suppliers";
import { products } from "./routes/products";
import { review } from "./routes/review";
import { labour } from "./routes/labour";
import { costing } from "./routes/costing";
import { conversations } from "./routes/conversations";
import { finance } from "./routes/finance";
import { intel } from "./routes/intel";
import { devices } from "./routes/devices";
import { templates } from "./routes/templates";
import { segments } from "./routes/segments";
import { voiceQuotes } from "./routes/voiceQuotes";
import { memos } from "./routes/memos";
import { officeTasks } from "./routes/officeTasks";
import { voice } from "./routes/voice";
import { visits } from "./routes/visits";
import { purchasing } from "./routes/purchasing";
import { payables } from "./routes/payables";
import { priceChecks } from "./routes/price-checks";
import { mail } from "./routes/mail";
import { swms } from "./routes/swms";
import { swmsLib } from "./routes/swms-lib";
import { people } from "./routes/people";
import { callbacks } from "./routes/callbacks";
import { bootMailAgent } from "./lib/mail-agent";
import { finishConnect } from "./lib/gmail";
import { bootReminders } from "./lib/reminders";
import { handleInboundSms, inboundSecretOk } from "./lib/sms-inbound";

// Terra Ops — Terra Flooring only. Admin procedures are built on `adminOnly`,
// the installer app talks exclusively to `field` (installerOnly, scoped to the
// signed-in installer). Pricing never leaves the admin routes.
export const router = {
  ping,
  /** Deploy check: can the live server reach the database. No data, no secrets. */
  diag,
  diagThrow,
  diagActor,
  settings,
  contacts,
  companies,
  sites,
  installers,
  /** Blackout dates — typed in plain English, enforced server-side. */
  availability,
  jobs,
  tasks,
  offers,
  quotes,
  quoteBundles,
  /** The assistant in the quote builder: checks, answers, proposes. Only Apply changes the quote. */
  quoteAgent,
  /** Damien dictates a job note on site, this turns the recording into a draft quote. */
  voiceQuotes,
  /** Voice memos: from a job card, a client record, or the global mic. One router, any action. */
  memos,
  /** Office to-dos and timed reminders, mostly made by voice memos. */
  officeTasks,
  field,
  /** Hands-free crew: Siri asks, confirm-back before anything is sent. */
  voice,
  /** Arrived and left site, by geofence or by hand, and the every-day photo rule. */
  visits,
  /** The installer's own invoice to Terra for a completed task. */
  installerInvoices,
  /** Presigned direct-to-storage uploads for photos, video and plans. */
  upload,
  /** Rooms and zones the work covers — photos hang off these. */
  areas,
  /** The job file: named media buckets, never a loose diary feed. */
  media,
  /** On-site forms. Crew describe and photograph; the OFFICE prices variations. */
  forms,
  /** Live crew map — on-shift positions only, consent-gated. */
  crew,
  dashboard,
  /**
   * The native app itself: who is signed in and what their role lets them see,
   * plus the push token for each phone.
   */
  devices,
  /** Who can sign in, what they can see, and which installer card they are. */
  team,
  /** Who Terra buys from, and every charge a supplier adds on top of the rate. */
  suppliers,
  /** The price book: variants, standard prices, and dated specials that revert themselves. */
  products,
  /** Sorting the ServiceM8 import: what is a homeowner, what is a business. */
  review,
  /** Labour rate book: Terra defaults, installer overrides, effective-dated history. */
  labour,
  /** What a job makes: sale, materials, labour off the rate book, GP and margin. */
  costing,
  /** Every message on a job or quote: email, SMS, app, internal notes. */
  conversations,
  /**
   * Payment terms, job costs, and the cashflow forecast. Committed, expected
   * and pipeline money are reported separately, never as one number.
   */
  finance,
  /**
   * Client, company and supervisor value: revenue AND gross profit, with the
   * underlying numbers shown instead of a made-up score.
   */
  intel,
  /**
   * Marketing email bodies. Plain text with merge fields, because that is what
   * lands in an inbox instead of the promotions tab. Cannot send to a customer:
   * the only send here is a test to the signed-in staff member.
   */
  templates,
  /**
   * Who a message may go to. Every count comes back as a pair — matching and
   * reachable — because one number hides a consent problem. Builder segments
   * are forced non-journey-eligible on write.
   */
  segments,
  /** Phase 0 — Damien can pull all his data out himself, any time. */
  backups,
  /** Purchase orders raised from a job: 4113-A, 4113-B. Sent from team@ with the PDF. */
  purchasing,
  /** Suppliers owed: invoices the email agent read, matched to POs. */
  payables,
  /** Invoice rates that differ from the price list. Damien approves each change. */
  priceChecks,
  /** SWMS for Terra Crew: signed per worker per day before Start and Complete, plus the SDS library. */
  swms,
  swmsLib,
  /** The email agent's three mailboxes. Read only, team@ can also send. */
  mail,
  /** Job and quote people, duplicate cards, company retype, and referral value. */
  people,
  /** Return visits linked to the original job, shown as 3981-C1. Rework cost is Admin only. */
  callbacks,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);

// Better Auth (email/password + Runable managed Google) — Hono v4 single wildcard.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Replies to the two-way SMS number. ClickSend does not sign posts, so the URL carries a secret.
app.post("/api/webhooks/clicksend/inbound/:secret", async (c) => {
  if (!inboundSecretOk(c.req.param("secret"))) return c.json({ ok: false }, 404);
  const type = c.req.header("content-type") ?? "";
  let raw: Record<string, unknown> = {};
  try {
    raw = type.includes("application/json")
      ? ((await c.req.json()) as Record<string, unknown>)
      : (Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : ""])) as Record<string, unknown>);
  } catch {
    return c.json({ ok: false, reason: "unreadable" }, 400);
  }
  try {
    const out = await handleInboundSms(raw);
    return c.json({ ok: true, ...out }, 200);
  } catch (e) {
    console.error("[sms-inbound] failed", e);
    /* A 500 makes ClickSend retry, which is what we want for a hiccup. */
    return c.json({ ok: false }, 500);
  }
});

// Google sends the mailbox sign-in back here. Checks happen in finishConnect: fresh state,
// the right account, and no scope beyond read (and send for team@).
app.get("/api/mail/oauth/callback", async (c) => {
  const back = (q: Record<string, string>) => c.redirect(`/settings?${new URLSearchParams(q)}#email-agent`, 302);
  const err = c.req.query("error");
  if (err) return back({ mail: "error", reason: err === "access_denied" ? "Sign-in was cancelled." : err });
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return back({ mail: "error", reason: "Google did not send a code back." });
  try {
    const r = await finishConnect(code, state);
    return back({ mail: "connected", address: r.address });
  } catch (e) {
    return back({ mail: "error", reason: String((e as Error).message ?? e).slice(0, 300) });
  }
});

// Marketing journeys tick here. Gated to the published server only — see lib/journey-boot.
bootJourneyEngine();
// Timed reminders push to the phone. Same published-server-only gate, see lib/reminders.
bootReminders();
// Reads supplier invoices from billing@, damien@ and team@ every 15 minutes. Same gate.
bootMailAgent();
// Copies the database and every stored file to Supabase every 6 hours. Same gate.
bootOffsiteBackup();

export default app;
