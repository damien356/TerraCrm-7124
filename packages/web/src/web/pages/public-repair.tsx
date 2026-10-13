import { useParams } from "wouter";
import { Spinner } from "../components/ui/card";
import { PublicCard, PublicMessage, PublicShell, errorText } from "../components/public-shell";
import { useRepairPhotos } from "../queries/timber";

/**
 * /r/<token>: Marc's photo page (spec 14 Oct, Part B, notes 18.38). No login.
 * Repair type, area, floor type, suburb and the photos at full size. Never
 * the client's name, phone, email, street address or any price. He replies
 * to the text with his price ex GST, or SEE.
 */

const longDay = (d: Date | string) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", timeZone: "Australia/Brisbane" });

export default function PublicRepairPage() {
  const { token = "" } = useParams<{ token: string }>();
  const page = useRepairPhotos(token);

  if (page.isLoading) {
    return (
      <PublicShell>
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </PublicShell>
    );
  }
  if (page.error || !page.data) {
    return (
      <PublicShell>
        <PublicMessage title="We could not open these photos">{errorText(page.error ?? "This link is not valid. Ask Terra to text it again.")}</PublicMessage>
      </PublicShell>
    );
  }
  const d = page.data;
  if (d.expired) {
    return (
      <PublicShell>
        <PublicMessage title="This link has run out">Links last 14 days. Ask Terra to text you a fresh one.</PublicMessage>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <PublicCard title="Timber repair to price">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-5 py-4 text-sm">
          <dt className="text-muted-foreground">Repair</dt>
          <dd className="font-medium">{d.repairType}</dd>
          <dt className="text-muted-foreground">Area</dt>
          <dd>{d.area || "Not given"}</dd>
          <dt className="text-muted-foreground">Floor</dt>
          <dd>{d.floorType}</dd>
          <dt className="text-muted-foreground">Suburb</dt>
          <dd>{d.suburb || "Not given"}</dd>
        </dl>
        <p className="border-t border-border px-5 py-3 text-sm">
          Reply to the text with your price ex GST, for example <span className="font-semibold">350</span>. Reply <span className="font-semibold">SEE</span> if you need to look at it first.
        </p>
      </PublicCard>

      {d.photos.length === 0 ? (
        <PublicMessage title="No photos yet">The client has not sent any photos. Reply SEE and we will book a look.</PublicMessage>
      ) : (
        <div className="space-y-3">
          {d.photos.map((p, i) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-card">
              <img src={p.url} alt={`Damage ${i + 1} of ${d.photos.length}`} className="h-auto w-full" />
            </a>
          ))}
        </div>
      )}
      <p className="mt-4 text-center text-xs text-muted-foreground">This link works until {longDay(d.expiresAt)}.</p>
    </PublicShell>
  );
}
