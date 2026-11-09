import { useRef, useState } from "react";
import { Archive, Camera, Eye, EyeOff, FileText, Lock, PlayCircle, Plus, RotateCcw, ShieldAlert, Trash2, Upload, Video } from "lucide-react";
import { FileViewer } from "./file-viewer";
import { AccessNoteProposals } from "./access-note-proposals";
import { useBootstrap } from "../queries/settings";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import {
  uploadToStorage,
  useArchiveMedia,
  useApproveForCrew,
  useAttachMedia,
  useCreateArea,
  useKeepOffice,
  useReclassifyMedia,
  useJobAreas,
  useJobMedia,
  useRemoveArea,
} from "../queries/media";

/**
 * THE JOB FILE. Named buckets, not a diary. A photo lives in exactly one slot,
 * so nothing ever ends up "somewhere in the feed".
 */
const BUCKETS = [
  { key: "plan", label: "Plans", blurb: "The plan the crew works off. PDF or photo." },
  { key: "access", label: "Site access", blurb: "Parking, lift, gate code, stairs. Photos and a walk-in video." },
  { key: "area", label: "Areas we're doing", blurb: "Room by room, with the m² that goes on the quote." },
  { key: "damage", label: "Existing damage", blurb: "Before we start. The crew can add but never delete." },
  { key: "found", label: "What we found", blurb: "Subfloor, moisture, nasties. Flags a variation to you." },
  { key: "completion", label: "Completion", blurb: "Required before the crew can mark the job done." },
  { key: "defect", label: "Defects & callbacks", blurb: "Kept apart so it never pollutes the finished set." },
  {
    key: "client_reported",
    label: "Client photos",
    blurb: "What the client sent in about the problem. Save emailed or texted photos here. The crew sees them read only.",
  },
  { key: "signed", label: "Signed documents", blurb: "Signed paperwork, such as an accepted variation. Office only. The crew never sees this." },
] as const;

type BucketKey = (typeof BUCKETS)[number]["key"];

function kindOf(file: File): "photo" | "video" | "doc" {
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("video/")) return "video";
  return "doc";
}

function stamp(value: Date | string) {
  return new Date(value).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Tile = {
  locked: boolean;
  sensitivity: string;
  visibility: string;
  reviewStatus: string;
  restrictLabel: string | null;
  bucket: string;
  archivedAt: Date | string | null;
};

/** Who can see a file, in words, on every tile. */
function PrivacyBadge({ m }: { m: Tile }) {
  if (m.sensitivity === "restricted") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#B4232A]/10 px-2 py-0.5 text-[10px] font-semibold text-[#8F1D22]">
        <Lock className="size-3" /> Restricted{m.restrictLabel ? `: ${m.restrictLabel}` : ""}
      </span>
    );
  }
  if (m.visibility === "crew") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#2F6B3A]/10 px-2 py-0.5 text-[10px] font-medium text-[#24552D]">
        <Eye className="size-3" /> Crew can see
      </span>
    );
  }
  if (m.reviewStatus === "needs_review") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#C77A12]/15 px-2 py-0.5 text-[10px] font-semibold text-[#8A520A]">
        <ShieldAlert className="size-3" /> Needs review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <EyeOff className="size-3" /> Office only
    </span>
  );
}

function AreaManager({ jobId }: { jobId: number }) {
  const areas = useJobAreas(jobId);
  const create = useCreateArea();
  const remove = useRemoveArea();
  const [name, setName] = useState("");
  const [m2, setM2] = useState("");

  return (
    <div className="border-b border-border bg-[var(--gold-wash)]/60 px-4 py-3">
      <p className="label-xs mb-2">Areas on this job</p>
      <div className="flex flex-wrap gap-1.5">
        {(areas.data ?? []).map((a) => (
          <span
            key={a.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs"
          >
            {a.name}
            {a.areaM2 ? <span className="text-muted-foreground">{a.areaM2} m²</span> : null}
            <button
              type="button"
              aria-label={`Remove ${a.name}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => remove.mutate({ id: a.id })}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        ))}
        {(areas.data ?? []).length === 0 ? (
          <span className="text-xs text-muted-foreground">No areas yet. Add the rooms you're covering.</span>
        ) : null}
      </div>
      <div className="mt-2.5 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Kitchen"
          className="h-8 max-w-[200px]"
        />
        <Input
          value={m2}
          onChange={(e) => setM2(e.target.value)}
          placeholder="m²"
          inputMode="decimal"
          className="h-8 max-w-[90px]"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!name.trim() || create.isPending}
          onClick={async () => {
            await create.mutateAsync({ jobId, name: name.trim(), areaM2: m2 ? Number(m2) : null });
            setName("");
            setM2("");
          }}
        >
          <Plus className="size-3.5" /> Add area
        </Button>
      </div>
    </div>
  );
}

export function JobFile({ jobId, isCallback = false }: { jobId: number; isCallback?: boolean }) {
  const [bucket, setBucket] = useState<BucketKey>("plan");
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** The open viewer: which category and which file it opened on. */
  const [viewing, setViewing] = useState<{ bucket: BucketKey; id: number } | null>(null);

  const media = useJobMedia(jobId, showArchived);
  const attach = useAttachMedia();
  const archive = useArchiveMedia();
  const showToCrew = useApproveForCrew();
  const keepOffice = useKeepOffice();
  const reclassify = useReclassifyMedia();
  const boot = useBootstrap();
  const isAdmin = boot.data?.actor.role === "admin";

  const groups = media.data ?? [];
  const active = groups.find((g) => g.bucket === bucket);
  const meta = BUCKETS.find((b) => b.key === bucket)!;
  const items = active?.items ?? [];
  /** Files waiting for a person before the crew can have them. */
  const toCheck = groups.flatMap((g) => g.items).filter((m) => !m.archivedAt && m.reviewStatus === "needs_review" && m.sensitivity !== "restricted").length;

  async function act(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    }
  }

  function restrictToggle(id: number, restricted: boolean) {
    const reason = window.prompt(restricted ? "Why is this file restricted? (kept in the activity feed)" : "Why lift the restriction? It goes back to Needs review, not to the crew.");
    if (!reason || reason.trim().length < 5) return;
    void act(() => reclassify.mutateAsync({ id, restricted, reason: reason.trim() }));
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const key = await uploadToStorage(file, jobId, bucket);
        await attach.mutateAsync({
          jobId,
          bucket,
          kind: kindOf(file),
          storageKey: key,
          filename: file.name,
          mime: file.type || null,
          sizeBytes: file.size,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "That upload didn't go through.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader
        title="Job file"
        subtitle="Every photo, video and plan in its own slot, never a loose diary feed."
        action={
          <Button size="sm" variant="secondary" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
        }
      />

      <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2.5">
        {BUCKETS.map((b) => {
          const count = groups.find((g) => g.bucket === b.key)?.items.length ?? 0;
          // Client photos only matter on a callback. Still shown anywhere something was filed there.
          if (b.key === "client_reported" && !isCallback && count === 0) return null;
          const on = b.key === bucket;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => setBucket(b.key)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                on ? "bg-[var(--charcoal)] text-white" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {b.label}
              <span className={`ml-1.5 tabular-nums ${on ? "text-[var(--gold-pale)]" : "text-muted-foreground/70"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <AccessNoteProposals jobId={jobId} />

      {toCheck ? (
        <div className="flex items-start gap-2 border-b border-border bg-[#C77A12]/10 px-4 py-2.5 text-xs text-[#6E4208]" data-testid="files-to-check">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">
              {toCheck} file{toCheck === 1 ? "" : "s"} marked Needs review.
            </span>{" "}
            The crew can't see {toCheck === 1 ? "it" : "them"} until you open {toCheck === 1 ? "it" : "each one"} and press Show to crew. Quotes, invoices, signed papers and payment records stay office only.
          </span>
        </div>
      ) : null}

      {bucket === "area" ? <AreaManager jobId={jobId} /> : null}

      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{meta.blurb}</p>
        <div className="flex items-center gap-2">
          {busy ? <Spinner /> : null}
          <input
            ref={fileRef}
            id={`upload-${bucket}`}
            type="file"
            aria-label={`Upload to ${meta.label}`}
            multiple
            accept="image/*,video/*,application/pdf"
            className="hidden"
            onChange={(e) => void onFiles(e.target.files)}
          />
          <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="size-3.5" /> Upload
          </Button>
        </div>
      </div>

      {error ? <p className="px-4 py-2 text-xs text-destructive">{error}</p> : null}

      {media.isLoading ? (
        <div className="p-6">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Empty>Nothing in {meta.label.toLowerCase()} yet.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
          {items.map((m) => m.locked ? (
            <figure key={m.id} className={`overflow-hidden rounded-lg border border-border bg-card ${m.archivedAt ? "opacity-55" : ""}`} data-media-id={m.id}>
              <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 bg-muted text-xs text-muted-foreground">
                <Lock className="size-7" />
                Restricted
              </div>
              <figcaption className="space-y-1 px-2.5 py-2">
                <PrivacyBadge m={m} />
                <p className="text-[11px] text-muted-foreground">Only people who can see costs can open this.</p>
              </figcaption>
            </figure>
          ) : (
            <figure
              key={m.id}
              className={`overflow-hidden rounded-lg border border-border bg-card ${m.archivedAt ? "opacity-55" : ""}`}
            >
              <button
                type="button"
                data-media-id={m.id}
                aria-label={`Open ${m.caption || m.filename || "file"} (${meta.label})`}
                onClick={() => setViewing({ bucket, id: m.id })}
                className="relative block aspect-square w-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-[var(--gold)]"
              >
                {m.kind === "photo" ? (
                  <img
                    src={m.url}
                    alt={m.caption ?? m.filename ?? "Job photo"}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                ) : m.kind === "video" ? (
                  <>
                    <video src={m.url} preload="metadata" muted playsInline aria-hidden className="pointer-events-none size-full object-cover">
                      <track kind="captions" />
                    </video>
                    <PlayCircle className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" />
                  </>
                ) : (
                  <span className="flex size-full flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <FileText className="size-7" />
                    {(m.filename ?? "").toLowerCase().endsWith(".pdf") || m.mime === "application/pdf" ? "PDF" : "File"}
                  </span>
                )}
              </button>
              <figcaption className="space-y-0.5 px-2.5 py-2">
                <p className="truncate text-xs font-medium">{m.caption || m.filename || "Untitled"}</p>
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {m.kind === "video" ? <Video className="size-3" /> : <Camera className="size-3" />}
                  {m.uploaderName ?? "Office"} · {stamp(m.capturedAt)}
                </p>
                <PrivacyBadge m={m} />
                {m.reviewStatus === "needs_review" && m.classifyNote ? <p className="text-[10px] text-muted-foreground">Check: {m.classifyNote}</p> : null}
                {!m.archivedAt && m.sensitivity !== "restricted" && m.bucket !== "signed" ? (
                  <div className="flex flex-wrap gap-x-2.5 gap-y-1 pt-0.5">
                    {m.visibility !== "crew" ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[#24552D] hover:underline"
                        onClick={() => void act(() => showToCrew.mutateAsync({ id: m.id }))}
                      >
                        <Eye className="size-3" /> Show to crew
                      </button>
                    ) : null}
                    {m.visibility === "crew" || m.reviewStatus === "needs_review" ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => void act(() => keepOffice.mutateAsync({ id: m.id }))}
                      >
                        <EyeOff className="size-3" /> {m.visibility === "crew" ? "Take off crew" : "Keep office only"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {isAdmin ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => restrictToggle(m.id, m.sensitivity !== "restricted")}
                  >
                    <Lock className="size-3" /> {m.sensitivity === "restricted" ? "Lift restriction" : "Restrict"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => archive.mutate({ id: m.id, archived: !m.archivedAt })}
                >
                  {m.archivedAt ? <RotateCcw className="size-3" /> : <Archive className="size-3" />}
                  {m.archivedAt ? "Restore" : "Archive"}
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {viewing ? (
        <FileViewer
          key={`${viewing.bucket}-${viewing.id}`}
          title={BUCKETS.find((b) => b.key === viewing.bucket)!.label}
          items={(groups.find((g) => g.bucket === viewing.bucket)?.items ?? []).filter((m) => !m.locked)}
          openId={viewing.id}
          onClose={() => setViewing(null)}
          refresh={async () => (await media.refetch()).data?.find((g) => g.bucket === viewing.bucket)?.items.filter((m) => !m.locked)}
        />
      ) : null}
    </Card>
  );
}
