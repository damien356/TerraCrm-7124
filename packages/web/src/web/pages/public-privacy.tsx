import * as React from "react";
import { PublicCard, PublicShell } from "../components/public-shell";

/**
 * /privacy-policy: the privacy policy for the website, Terra Ops and the Terra
 * phone app (notes 18.59). No login. Apple and Google link to it from the
 * store listings. Wording approved by Damien 17 Oct.
 */

const UPDATED = "17 October 2026";

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

export default function PublicPrivacyPage() {
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      document.title = "Privacy policy | Terra Flooring";
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <PublicShell>
      <div className="space-y-1 pb-4">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Privacy policy</h1>
        <p className="text-sm text-muted-foreground">Terra Flooring and the Terra apps. Last updated {UPDATED}.</p>
      </div>

      <div className="space-y-0 text-sm leading-relaxed">
        <PublicCard>
          <div className="space-y-0.5">
            <p className="font-semibold">Terra Flooring</p>
            <p>ABN 82 651 012 001</p>
            <p>2/22 Lawrence Dr, Nerang QLD</p>
            <p>
              <a className="text-[var(--gold)] hover:underline" href="mailto:team@terraflooring.com.au">
                team@terraflooring.com.au
              </a>
            </p>
            <p>
              <a className="text-[var(--gold)] hover:underline" href="tel:1300183772">
                1300 183 772
              </a>
            </p>
          </div>
        </PublicCard>

        <PublicCard>
          <div className="space-y-3">
            <p>
              Terra Flooring is a trading name of Arclan Pty Ltd (ACN 651 012 001, ABN 82 651 012 001). This policy covers
              our website, the Terra Ops office system, and the Terra phone app for iPhone and Android that our staff and
              crew use. It explains what we collect, why, and how we look after it.
            </p>
            <p>We follow the Australian Privacy Principles in the Privacy Act 1988.</p>
          </div>
        </PublicCard>

        <PublicCard title="What we collect">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="font-semibold">From our customers and builders</p>
              <List
                items={[
                  "Name, phone number, email address and the site address for the job.",
                  "Details of the job: measurements, quotes, invoices, notes and messages with us.",
                  "Photos and videos of the job site, taken before, during and after the work.",
                  "Signatures when a job is signed off.",
                ]}
              />
            </div>
            <div className="space-y-2">
              <p className="font-semibold">From our staff and crew who use the Terra app</p>
              <List
                items={[
                  "Name, email address and mobile number, used for your login.",
                  "The jobs and tasks you are booked on, with notes, photos and videos you add.",
                  "Your location, only if you allow it. The app uses it to mark you arrived and left at the sites you are booked on. If you switch on location sharing, the office can see where you are while a job is running. If you switch on arrive and leave by location, the app only reports crossing in or out of a circle around each site, never your route. You can turn location off at any time in your phone settings.",
                  "Voice recordings, only when you choose to record a voice quote on site. The recording is turned into a draft quote for the office to check.",
                  "A notification token, so we can send you job alerts.",
                  "Crash and error reports: what went wrong, the app version and the type of phone. These help us fix problems. They do not include your photos or messages.",
                ]}
              />
            </div>
          </div>
        </PublicCard>

        <PublicCard title="How we use it">
          <p>
            We only use this information to run our jobs: to quote, book, schedule and complete the work, to keep in touch
            with you about it, to invoice and get paid, to pay our crew, to keep sites safe, and to fix problems with our
            apps.
          </p>
        </PublicCard>

        <PublicCard title="What we never do">
          <List
            items={[
              "We never sell your information.",
              "We never use it for advertising by anyone else.",
              "We do not share it, except with the people who need it to do your job, such as the crew on your job, our suppliers for delivery, and the services that host our systems and send our texts and emails. They may only use it for that purpose.",
              "We give information to the government only when the law requires it.",
            ]}
          />
        </PublicCard>

        <PublicCard title="How we keep it safe">
          <div className="space-y-3">
            <p>
              Your information is stored securely with trusted hosting providers. Our systems use encrypted connections.
              Only our staff can sign in to the office system, and each person only sees what their role needs. Crew only
              see the jobs they are booked on.
            </p>
            <p>We keep job records for as long as the law requires for tax and building work, then delete them.</p>
          </div>
        </PublicCard>

        <PublicCard title="App store reviewers">
          <p>
            The login we give Apple and Google to review our app only opens a made up demo company. It never shows real
            customer information.
          </p>
        </PublicCard>

        <PublicCard title="Your choices">
          <div className="space-y-3">
            <p>
              You can ask to see the information we hold about you, ask us to correct it, or ask us to delete it where the
              law allows. Staff and crew can also ask us to close their app login.
            </p>
            <p>
              To see or delete your information, email{" "}
              <a className="text-[var(--gold)] hover:underline" href="mailto:team@terraflooring.com.au">
                team@terraflooring.com.au
              </a>
              .
            </p>
          </div>
        </PublicCard>

        <PublicCard title="Contact us">
          <div className="space-y-3">
            <div className="space-y-0.5">
              <p>Terra Flooring</p>
              <p>2/22 Lawrence Dr, Nerang QLD</p>
              <p>
                Email:{" "}
                <a className="text-[var(--gold)] hover:underline" href="mailto:team@terraflooring.com.au">
                  team@terraflooring.com.au
                </a>
              </p>
              <p>
                Phone:{" "}
                <a className="text-[var(--gold)] hover:underline" href="tel:1300183772">
                  1300 183 772
                </a>
              </p>
            </div>
            <p>
              If you are not happy with how we handled your information, contact us first. You can also contact the Office
              of the Australian Information Commissioner at{" "}
              <a className="text-[var(--gold)] hover:underline" href="https://www.oaic.gov.au" target="_blank" rel="noreferrer">
                oaic.gov.au
              </a>
              .
            </p>
          </div>
        </PublicCard>
      </div>
    </PublicShell>
  );
}
