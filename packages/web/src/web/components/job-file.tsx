import { useRef, useState } from "react";
import { Archive, ArrowUpRight, Camera, FileText, Plus, RotateCcw, Trash2, Upload, Video } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import {
  uploadToStorage,
  useArchiveMedia,
  useAttachMedia,
  useCreateArea,
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
          <span className="text-xs text-muted-foreground">No areas yet — add the rooms you're covering.</span>
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

export function JobFile({ jobId }: { jobId: number }) {
  const [bucket, setBucket] = useState<BucketKey>("plan");
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const media = useJobMedia(jobId, showArchived);
  const attach = useAttachMedia();
  const archive = useArchiveMedia();

  const groups = media.data ?? [];
  const active = groups.find((g) => g.bucket === bucket);
  const meta = BUCKETS.find((b) => b.key === bucket)!;
  const items = active?.items ?? [];

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
        subtitle="Every photo, video and plan in its own slot — never a loose diary feed."
        action={
          <Button size="sm" variant="secondary" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
        }
      />

      <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2.5">
        {BUCKETS.map((b) => {
          const count = groups.find((g) => g.bucket === b.key)?.items.length ?? 0;
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
          {items.map((m) => (
            <figure
              key={m.id}
              className={`overflow-hidden rounded-lg border border-border bg-card ${m.archivedAt ? "opacity-55" : ""}`}
            >
              <div className="aspect-square bg-muted">
                {m.kind === "photo" ? (
                  <img src={m.url} alt={m.caption ?? m.filename ?? "Job photo"} className="size-full object-cover" />
                ) : m.kind === "video" ? (
                  <video
                    src={m.url}
                    controls
                    aria-label={m.caption ?? m.filename ?? "Job video"}
                    className="size-full object-cover"
                  >
                    <track kind="captions" />
                  </video>
                ) : (
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex size-full flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <FileText className="size-7" />
                    Open file <ArrowUpRight className="size-3" />
                  </a>
                )}
              </div>
              <figcaption className="space-y-0.5 px-2.5 py-2">
                <p className="truncate text-xs font-medium">{m.caption || m.filename || "Untitled"}</p>
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {m.kind === "video" ? <Video className="size-3" /> : <Camera className="size-3" />}
                  {m.uploaderName ?? "Office"} · {stamp(m.capturedAt)}
                </p>
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
    </Card>
  );
}
