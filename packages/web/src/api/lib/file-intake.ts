import { and, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { askOfficeToCheck, checkLater, sha256, type Source } from "./doc-classify";

/* ---------------------------------------------------------------------------
 * Every file that reaches a job file from outside the crew app comes in here
 * (Damien, 9 Nov 2026: document privacy). Receive privately, then read it:
 *
 *   1. The row is written office only, needs review, with the email it came
 *      on. The crew can't list it, whatever its category.
 *   2. Its content is read (lib/doc-classify.ts). A quote, invoice or payment
 *      is restricted for good. Anything else from outside waits for the
 *      office to press Show to crew. Nothing is ever shown while it is read.
 *   3. The same file from the same email filed twice is the same row, so a
 *      re-run never makes a duplicate, relaxes a decision or alerts twice.
 * ------------------------------------------------------------------------- */

/** The category a file starts in before its content is read. Only a label: it never grants access. */
export const startBucketFor = (mime: string) => (/^(image|video)\//.test(mime) ? "client_reported" : "plan");
const kindFor = (mime: string) => (mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "doc");

export type InboundFile = {
  jobId: number;
  storageKey: string;
  filename: string | null;
  mime: string;
  sizeBytes?: number | null;
  caption: string;
  uploaderName: string;
  /** The email it came on. Null for a form upload. */
  sourceMessageId?: number | null;
  /** The bytes, when the caller already has them. Saves fetching them back. */
  bytes?: Buffer;
  bucket?: string;
  uploadedByProfileId?: number | null;
  capturedAt?: Date;
  tags?: string[];
};

/**
 * File one file and start reading it. The read runs after this returns (a
 * photo can take the reader a while), and the row is office only until it
 * has finished. A failed read leaves it office only with a review item.
 * Returns the job_media id.
 */
export async function fileInbound(f: InboundFile, source: Source = "external", by: { name: string; role: string } | null = null) {
  const [dupe] = await db
    .select({ id: schema.jobMedia.id })
    .from(schema.jobMedia)
    .where(and(eq(schema.jobMedia.jobId, f.jobId), eq(schema.jobMedia.storageKey, f.storageKey)))
    .limit(1);
  if (dupe) return dupe.id;

  const [row] = await db
    .insert(schema.jobMedia)
    .values({
      jobId: f.jobId,
      bucket: f.bucket ?? startBucketFor(f.mime),
      kind: kindFor(f.mime),
      storageKey: f.storageKey,
      url: f.storageKey,
      filename: f.filename,
      mime: f.mime,
      sizeBytes: f.sizeBytes ?? f.bytes?.length ?? null,
      caption: f.caption.slice(0, 300),
      uploaderName: f.uploaderName.slice(0, 120),
      uploadedByProfileId: f.uploadedByProfileId ?? null,
      sourceMessageId: f.sourceMessageId ?? null,
      contentSha256: f.bytes ? sha256(f.bytes) : null,
      visibility: "office",
      sensitivity: "unknown",
      reviewStatus: "needs_review",
      ...(f.capturedAt ? { capturedAt: f.capturedAt } : {}),
      ...(f.tags ? { tags: JSON.stringify(f.tags) } : {}),
    })
    .returning({ id: schema.jobMedia.id });
  const id = row!.id;
  // The review item first, so even a check that never finishes leaves the office a note.
  if (source === "external") await askOfficeToCheck(f.jobId).catch(() => null);
  void checkLater(id, source, by, f.bytes);
  return id;
}
