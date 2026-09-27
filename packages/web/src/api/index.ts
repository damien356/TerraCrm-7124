import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { auth } from "./auth";
import { ping, diag } from "./routes/ping";
import { settings } from "./routes/settings";
import { contacts } from "./routes/contacts";
import { companies, sites } from "./routes/companies";
import { installers } from "./routes/installers";
import { availability } from "./routes/availability";
import { jobs } from "./routes/jobs";
import { tasks } from "./routes/tasks";
import { offers } from "./routes/offers";
import { quotes } from "./routes/quotes";
import { field } from "./routes/field";
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

// Terra Ops — Terra Flooring only. Admin procedures are built on `adminOnly`,
// the installer app talks exclusively to `field` (installerOnly, scoped to the
// signed-in installer). Pricing never leaves the admin routes.
export const router = {
  ping,
  /** Deploy check: can the live server reach the database. No data, no secrets. */
  diag,
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
  field,
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
  /** Phase 0 — Damien can pull all his data out himself, any time. */
  backups,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);

// Better Auth (email/password + Runable managed Google) — Hono v4 single wildcard.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

export default app;
