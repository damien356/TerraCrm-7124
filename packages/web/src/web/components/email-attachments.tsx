import * as React from "react";
import { FileText, Paperclip, Plus, Upload, X } from "lucide-react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/card";
import { EmailInput } from "./email-input";
import { client } from "../lib/api";
import { useJobMedia } from "../queries/media";

/* ---------------------------------------------------------------------------
 * Files and copies on an email (job email thread, spec 15 Oct). Shared by the
 * job Conversation composer, Email quote, the variation send and the invoice
 * send, so attaching works the same everywhere:
 *   - From the job file: tick any number, signed papers included.
 *   - From the device: any number. Big photos are shrunk in the browser first,
 *     and every one is saved to the job file when it is sent.
 * Past 18 MB in all, the rest go as 7 day download links. The server decides
 * that, this only warns.
 * ------------------------------------------------------------------------- */

export type MailUpload = { storageKey: string; filename: string; mime: string; sizeBytes: number };
export type MailAttachments = { mediaIds: number[]; uploads: MailUpload[] };
export const NO_ATTACHMENTS: MailAttachments = { mediaIds: [], uploads: [] };

const ATTACH_LIMIT = 18 * 1024 * 1024;
const MAX_SIDE = 2400;
/** Photos past this are shrunk before they go up. */
const SHRINK_OVER = 1.5 * 1024 * 1024;

export const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Shrink a big photo with a canvas. Anything that is not a plain photo goes as it is. */
export async function shrinkPhoto(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= SHRINK_OVER) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** Put one device file in storage for an email. On a job it lands in that job's own folder. */
export async function uploadForMail(file: File, jobId: number | null): Promise<MailUpload> {
  const ready = await shrinkPhoto(file);
  const contentType = ready.type || "application/octet-stream";
  const { url, key } = await client.conversations.uploadSlot({ filename: ready.name, contentType, jobId });
  const res = await fetch(url, { method: "PUT", body: ready, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error(`${file.name} did not upload. Try again.`);
  return { storageKey: key, filename: ready.name, mime: contentType, sizeBytes: ready.size };
}

/** The CC list: one address per row, plus quick picks from the job's people. */
export function CcList({
  value,
  onChange,
  suggestions = [],
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: Array<{ email: string; name: string }>;
}) {
  const unused = suggestions.filter((s) => s.email && !value.some((v) => v.trim().toLowerCase() === s.email.toLowerCase()));
  return (
    <div className="grid gap-1.5">
      {value.map((v, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <EmailInput
            wrapperClassName="flex-1"
            value={v}
            placeholder="name@example.com"
            onValueChange={(nv) => onChange(value.map((x, j) => (j === i ? nv : x)))}
          />
          <Button type="button" variant="ghost" size="icon-sm" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, ""])}>
          <Plus className="size-3.5" /> Add CC
        </Button>
        {unused.slice(0, 6).map((s) => (
          <Button key={s.email} type="button" size="sm" variant="ghost" onClick={() => onChange([...value, s.email])}>
            <Plus className="size-3.5" /> {s.name || s.email}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Pick files for an email. `extraBytes` is what is already going, like the quote PDF. */
export function EmailAttachments({
  jobId,
  value,
  onChange,
  extraBytes = 0,
  note,
}: {
  jobId: number | null;
  value: MailAttachments;
  onChange: (v: MailAttachments) => void;
  extraBytes?: number;
  note?: string;
}) {
  const [picking, setPicking] = React.useState(false);
  const [uploading, setUploading] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const media = useJobMedia(picking || value.mediaIds.length ? jobId : null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const latest = React.useRef(value);
  latest.current = value;

  const all = (media.data ?? []).flatMap((b) => b.items.map((it) => ({ ...it, bucketLabel: b.label })));
  const pickedMedia = all.filter((m) => value.mediaIds.includes(m.id));
  const total = extraBytes + pickedMedia.reduce((s, m) => s + (m.sizeBytes ?? 0), 0) + value.uploads.reduce((s, u) => s + u.sizeBytes, 0);

  const toggle = (id: number) =>
    onChange({ ...value, mediaIds: value.mediaIds.includes(id) ? value.mediaIds.filter((x) => x !== id) : [...value.mediaIds, id] });

  async function addFiles(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setError(null);
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const up = await uploadForMail(f, jobId);
        onChange({ ...latest.current, uploads: [...latest.current.uploads, up] });
      } catch (e) {
        setError(e instanceof Error ? e.message : `${f.name} did not upload.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  const count = value.mediaIds.length + value.uploads.length;

  return (
    <div className="rounded-lg border border-border bg-background/60 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Paperclip className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Attachments{count ? ` (${count})` : ""}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {jobId ? (
            <Button type="button" size="sm" variant={picking ? "default" : "outline"} onClick={() => setPicking((p) => !p)}>
              <FileText className="size-3.5" /> From job file
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading > 0}>
            {uploading ? <Spinner /> : <Upload className="size-3.5" />} From device
          </Button>
          <input ref={inputRef} type="file" multiple aria-label="Attach files from this device" className="hidden" onChange={(e) => void addFiles(e.target.files)} />
        </span>
      </div>

      {note ? <p className="mt-1 text-[11px] text-muted-foreground">{note}</p> : null}

      {picking ? (
        media.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Opening the job file…</p>
        ) : all.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Nothing in the job file yet.</p>
        ) : (
          <div className="mt-2 grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto sm:grid-cols-4">
            {all.map((m) => {
              const on = value.mediaIds.includes(m.id);
              const isImg = (m.mime ?? "").startsWith("image/") || m.kind === "photo";
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggle(m.id)}
                  title={`${m.bucketLabel}: ${m.filename ?? m.kind}`}
                  className={[
                    "relative flex h-20 flex-col items-center justify-center overflow-hidden rounded-md border text-left text-[10px]",
                    on ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/40" : "border-border",
                  ].join(" ")}
                >
                  {isImg && m.url ? (
                    <img src={m.url} alt="" className="absolute inset-0 size-full object-cover" />
                  ) : (
                    <FileText className="size-5 text-muted-foreground" />
                  )}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-white">{m.filename ?? m.bucketLabel}</span>
                  {on ? <span className="absolute right-1 top-1 rounded bg-[var(--primary)] px-1 text-[10px] text-white">Picked</span> : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}

      {count ? (
        <ul className="mt-2 grid gap-1">
          {pickedMedia.map((m) => (
            <li key={`m${m.id}`} className="flex items-center gap-2 text-xs">
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{m.filename ?? m.bucketLabel}</span>
              <span className="text-muted-foreground">{m.sizeBytes ? sizeLabel(m.sizeBytes) : ""}</span>
              <Button type="button" variant="ghost" size="icon-sm" title="Take off" onClick={() => toggle(m.id)}>
                <X className="size-3" />
              </Button>
            </li>
          ))}
          {value.mediaIds.length > pickedMedia.length ? (
            <li className="text-xs text-muted-foreground">{value.mediaIds.length - pickedMedia.length} more from the job file</li>
          ) : null}
          {value.uploads.map((u) => (
            <li key={u.storageKey} className="flex items-center gap-2 text-xs">
              <Upload className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{u.filename}</span>
              <span className="text-muted-foreground">{sizeLabel(u.sizeBytes)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Take off"
                onClick={() => onChange({ ...value, uploads: value.uploads.filter((x) => x.storageKey !== u.storageKey) })}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {total > ATTACH_LIMIT ? (
        <p className="mt-1.5 text-[11px] text-amber-800">
          {sizeLabel(total)} in all. Past 18 MB the rest go as download links that work for 7 days.
        </p>
      ) : null}
      {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
