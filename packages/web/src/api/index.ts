import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { auth } from "./auth";
import { bootJourneyEngine } from "./lib/journey-boot";
import { bootOffsiteBackup } from "./lib/offsite-backup-boot";
import { bootOfferTimer } from "./lib/offer-timer";
import { handleWebhook as handleStripeWebhook } from "./lib/stripe";
import { rebuildForecast } from "./lib/cashflow";
import { ping, diag, diagThrow, diagActor } from "./routes/ping";
import { settings } from "./routes/settings";
import { contacts } from "./routes/contacts";
import { companies, sites } from "./routes/companies";
import { installers } from "./routes/installers";
import { availability } from "./routes/availability";
import { jobs } from "./routes/jobs";
import { tasks } from "./routes/tasks";
import { dispatches } from "./routes/dispatches";
import { offers } from "./routes/offers";
import { quotes } from "./routes/quotes";
import { quoteBundles } from "./routes/quoteBundles";
import { quoteCopy } from "./routes/quoteCopy";
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
import { priceImport } from "./routes/priceImport";
import { productDelete } from "./routes/productDelete";
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
import { referrals } from "./routes/referrals";
import { billTo } from "./routes/billTo";
import { alerts } from "./routes/alerts";
import { aiActions } from "./routes/aiActions";
import { voice } from "./routes/voice";
import { visits } from "./routes/visits";
import { purchasing } from "./routes/purchasing";
import { payables } from "./routes/payables";
import { priceChecks } from "./routes/price-checks";
import { mail } from "./routes/mail";
import { swms } from "./routes/swms";
import { swmsLib } from "./routes/swms-lib";
import { people } from "./routes/people";
import { places } from "./routes/places";
import { callbacks } from "./routes/callbacks";
import { quoteSend } from "./routes/quoteSend";
import { clientInvoices } from "./routes/clientInvoices";
import { delivery } from "./routes/delivery";
import { siteFill } from "./routes/siteFill";
import { emailCheck } from "./routes/emailCheck";
import { productFind } from "./routes/productFind";
import { publicPages } from "./routes/publicPages";
import { jobCancel } from "./routes/jobCancel";
import { jobMerge } from "./routes/jobMerge";
import { variations } from "./routes/variations";
import { underlayUpgrades } from "./routes/underlayUpgrades";
import { care } from "./routes/care";
import { bootCareEngine } from "./lib/care-boot";
import { PIXEL_GIF, recordOpen, unsubscribeContact, unsubscribePage } from "./lib/unsubscribe";
import { readUnsubscribeToken } from "./lib/marketing";
import { bootMailAgent } from "./lib/mail-agent";
import { finishConnect } from "./lib/gmail";
import { bootReminders } from "./lib/reminders";
import { bootDailySummary, wakeDailySummary } from "./lib/notify";
import { judgeWake } from "./lib/wake-guard";
import { bootPrep } from "./lib/prep";
import { prep } from "./routes/prep";
import { invites } from "./routes/invites";
import { fieldPrep } from "./routes/fieldPrep";
import { handleInboundSms, inboundSecretOk } from "./lib/sms-inbound";
import { takeLead, type LeadFile } from "./lib/lead-intake";
import { bootTimberRepair } from "./lib/timber-repair";
import { bootAbnRecheck } from "./lib/abn-recheck";
import { abnCheck } from "./routes/abnCheck";
import { leads } from "./routes/leads";
import { timber } from "./routes/timber";

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
  /** Notes 18.64: ABN Lookup on installer cards, Admin only. */
  abnCheck,
  /** Blackout dates — typed in plain English, enforced server-side. */
  availability,
  jobs,
  tasks,
  /** Split by trade and Merge on the job page. */
  dispatches,
  offers,
  quotes,
  quoteBundles,
  /** Copy from previous job and Duplicate this quote (notes 18.46). */
  quoteCopy,
  /** The assistant in the quote builder: checks, answers, proposes. Only Apply changes the quote. */
  quoteAgent,
  /** Damien dictates a job note on site, this turns the recording into a draft quote. */
  voiceQuotes,
  /** Voice memos: from a job card, a client record, or the global mic. One router, any action. */
  memos,
  /** Office to-dos and timed reminders, mostly made by voice memos. */
  officeTasks,
  /** Referral fees (notes 18.47). Admin only, except picking the referrer on a job. */
  referrals,
  billTo,
  /** Client prep messages: install email, day before text, On my way (notes 18.56). */
  prep,
  /** Staff invites: download page and one-time set-up link (notes 18.55). */
  invites,
  alerts,
  /** Step 1 (20 Oct): the AI log and the "Waiting for you" tray. Admin only. */
  aiActions,
  field,
  fieldPrep,
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
  /** Settings, Price list: template, export, import with preview, undo. Admin only. */
  priceImport,
  /** Settings, Price list: delete unused products, hide used ones, undo last delete. Admin only. */
  productDelete,
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
  /** Address suggestions for a new site. The Google key stays on the server. */
  places,
  /** Return visits linked to the original job, shown as 3981-C1. Rework cost is Admin only. */
  callbacks,
  /** Email a quote from team@ with the PDF and the no-login link, and the link's view count. */
  quoteSend,
  /** IQ invoices to the client: deposit, variations, final. Admin and Office mark paid, Admin voids. */
  clientInvoices,
  delivery,
  /** A quote with a delivery line and no site asks for one, and a job with no site offers one (188001 list item 12). */
  siteFill,
  emailCheck,
  /** One search box for the supply pickers, and what a range was last quoted at (188001 list items 3, 4, 18). */
  productFind,
  /** Variations on a job after its quote is accepted: priced off the books, sent, accepted, billed (item 12). */
  variations,
  /** Settings: which underlay upgrades to which, for the offer on the material selection form (item 9). */
  underlayUpgrades,
  /** After the job care series: who is in it, the emails, opens and unsubscribes, the wool question. */
  care,
  /** Lead sources, landing pages, ad spend and the leads report. Admin only, bar the source list. */
  leads,
  /** Timber repairs priced by Marc: the repair screen, Approve, and the no-login photo page. */
  timber,
  /** No-login pages for clients: /q/<token> read and sign a quote, /m/<token> choose flooring. Never returns cost. */
  publicPages,
  jobCancel,
  jobMerge,
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

// Outside wake call for the 7am summary (cron-job.org). Needs the secret in the
// X-Terra-Wake-Key header and is rate limited (lib/wake-guard). No login, no
// data back. It runs one pass of the daily timer, which sends once a day at most.
app.get("/api/wake", async (c) => {
  c.header("cache-control", "no-store");
  const v = judgeWake(c.req.raw.headers);
  if (v.status !== 200) {
    if (v.retryAfterSec) c.header("retry-after", String(v.retryAfterSec));
    if (v.status === 429) console.warn("[wake] rate limited");
    return c.json({ ok: false }, v.status);
  }
  try {
    const out = await wakeDailySummary();
    return c.json({ ok: true, ticking: out.ticking }, 200);
  } catch {
    return c.json({ ok: true, ticking: false }, 200);
  }
});

// Landing page forms (notes 18.38). Public: each page posts its own fields here,
// as JSON, a plain form or a form with photos. Spam checks are in lib/lead-intake.
const LEAD_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*terraflooring\.com\.au$/i;
const leadCors = (origin: string | undefined): Record<string, string> =>
  origin && LEAD_ORIGIN_RE.test(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : {};
app.options("/api/leads/:formKey", (c) => c.body(null, 204, leadCors(c.req.header("origin"))));
app.post("/api/leads/:formKey", async (c) => {
  const headers = leadCors(c.req.header("origin"));
  const size = Number(c.req.header("content-length") ?? 0);
  if (size > 120 * 1024 * 1024) return c.json({ ok: false, reason: "too big" }, 413, headers);
  const type = c.req.header("content-type") ?? "";
  const raw: Record<string, unknown> = {};
  const files: LeadFile[] = [];
  try {
    if (type.includes("application/json")) {
      Object.assign(raw, (await c.req.json()) as Record<string, unknown>);
    } else {
      const body = await c.req.parseBody({ all: true });
      for (const [k, v] of Object.entries(body)) {
        for (const item of Array.isArray(v) ? v : [v]) {
          if (typeof item === "string") raw[k] = raw[k] == null ? item : `${String(raw[k])}, ${item}`;
          else if (item && typeof item === "object" && "arrayBuffer" in item && files.length < 12) {
            const f = item as File;
            files.push({ name: f.name || "photo.jpg", type: f.type || "", bytes: Buffer.from(await f.arrayBuffer()) });
          }
        }
      }
    }
  } catch {
    return c.json({ ok: false, reason: "unreadable" }, 400, headers);
  }
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (c.req.header("cf-connecting-ip") || fwd || c.req.header("x-real-ip") || "").slice(0, 64);
  try {
    const out = await takeLead(c.req.param("formKey"), raw, files, { ip, userAgent: c.req.header("user-agent"), origin: c.req.header("origin") });
    // Spam gets the same answer as a real lead, so a bot learns nothing.
    return c.json({ ok: true, ...(out.verdict === "ok" ? { ref: out.jobNumber } : {}) }, 200, headers);
  } catch (e) {
    console.error("[leads] intake failed", e);
    return c.json({ ok: false }, 500, headers);
  }
});

// Stripe tells us a card payment went through (fix list item 6). Signed with the webhook secret.
// A 500 makes Stripe retry later, which is what we want for a hiccup.
app.post("/api/webhooks/stripe", async (c) => {
  const raw = await c.req.text();
  try {
    const out = await handleStripeWebhook(raw, c.req.header("stripe-signature"));
    if (out.status === 200 && "result" in out.body) {
      await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after card payment failed:", e));
    }
    return c.json(out.body, out.status);
  } catch (e) {
    console.error("[stripe] webhook failed", e);
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

// The unsubscribe link in every marketing email. The GET only shows a button, because mail
// scanners open every link. The POST unsubscribes, and is also Gmail's one-click (RFC 8058).
app.get("/api/unsubscribe/:token", (c) => {
  const ok = readUnsubscribeToken(c.req.param("token")) !== null;
  return c.html(ok ? unsubscribePage("ask") : unsubscribePage("bad", "That link is not one of ours, or it was cut short."), ok ? 200 : 400);
});
app.post("/api/unsubscribe/:token", async (c) => {
  try {
    const oneClick = (c.req.header("content-type") ?? "").includes("form") && (await c.req.text()).includes("List-Unsubscribe=One-Click");
    const out = await unsubscribeContact(c.req.param("token"), oneClick ? "one_click" : "link");
    if (!out.ok) return c.html(unsubscribePage("bad", out.reason), 400);
    return c.html(unsubscribePage("done"), 200);
  } catch (e) {
    console.error("[unsubscribe] failed", e);
    return c.html(unsubscribePage("bad", "We could not save that just now. Please try again in a minute."), 500);
  }
});

// The care emails' open pixel. Always answers with the GIF, whatever happens.
app.get("/api/o/:file", async (c) => {
  await recordOpen(c.req.param("file"));
  return c.body(PIXEL_GIF, 200, { "content-type": "image/gif", "cache-control": "no-store, no-cache, must-revalidate, max-age=0" });
});

// Marketing journeys tick here. Gated to the published server only — see lib/journey-boot.
bootJourneyEngine();
// Timed reminders push to the phone. Same published-server-only gate, see lib/reminders.
bootReminders();
// Reads supplier invoices from billing@, damien@ and team@ every 15 minutes. Same gate.
bootMailAgent();
// Copies the database and every stored file to Supabase every 6 hours. Same gate.
bootOffsiteBackup();
// Expires offers and locks lapsed 2-hour holds once a minute. Same gate.
bootOfferTimer();
// The 7am summary email to the office (item 15). Same gate.
bootDailySummary();
// Client prep messages from 10am, checked every 5 minutes (notes 18.56). Same gate.
bootPrep();
// The after job care series, every 10 minutes. Same gate, and off until switched on in Marketing, Care.
bootCareEngine();
// Timber repairs: pushes the office when Marc has not priced one in 2 hours. Same gate.
bootTimberRepair();
// The monthly ABN recheck on installer cards (notes 18.64). Same gate.
bootAbnRecheck();

export default app;
