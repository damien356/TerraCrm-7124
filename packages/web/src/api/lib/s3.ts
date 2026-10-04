import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { inDemo } from "../database";

export const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: false,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET;

/**
 * The Google Play reviewer's files live under demo/ and nowhere else. Every
 * read, write and signed link goes through this, so a demo request can never
 * open or overwrite a real job photo, invoice or PO, whatever key it passes.
 */
function scoped(key: string) {
  if (!inDemo()) return key;
  return key.startsWith("demo/") ? key : `demo/${key.replace(/^\/+/, "")}`;
}

/** Upload straight from the phone or browser — never through the API server. */
export function signPut(key: string, contentType: string) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: scoped(key), ContentType: contentType }), {
    expiresIn: 900,
  });
}

/** Read links are short-lived and signed — job photos are not public. */
export function signGet(key: string, expiresIn = 3600) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: scoped(key) }), { expiresIn });
}

/** Sign a whole batch of rows at once. */
export async function signMany<T extends { storageKey: string }>(rows: T[]) {
  return Promise.all(rows.map(async (r) => ({ ...r, url: await signGet(r.storageKey) })));
}

/** Slugged, collision-proof object key. */
export function mediaKey(jobId: number, bucket: string, filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60);
  return `jobs/${jobId}/${bucket}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}

/** A voice quote capture's own audio recording, not tied to any job yet. */
export function voiceAudioKey(filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60);
  return `voice-quotes/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}

/** An installer's own logo, not tied to any job. */
export function installerLogoKey(installerId: number, filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60);
  return `installers/${installerId}/logo/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}

/** Where a submitted subcontractor invoice PDF is stored. */
export function invoicePdfKey(installerId: number, taskId: number) {
  return `installers/${installerId}/invoices/task-${taskId}-${Date.now()}.pdf`;
}

/** Read a stored file back into memory, to re-attach a generated PDF to an email. */
export async function getObject(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: scoped(key) }));
  if (!res.Body) throw new Error(`Nothing stored at ${key}`);
  return Buffer.from(await res.Body.transformToByteArray());
}

/**
 * Server writes a file straight to storage (used for generated PDFs, not client uploads).
 *
 * `downloadAs` is the filename a browser should SAVE the object under, and it
 * has to be set here, on the write. Tigris serves the disposition stored with
 * the object and ignores the `response-content-disposition` override on a
 * presigned link, so a PDF written without this opens inline in a tab named
 * after its storage key, which is what a phone shows instead of downloading it.
 */
export async function putObject(key: string, body: Buffer, contentType: string, downloadAs?: string) {
  const safeName = downloadAs?.replace(/["\\\r\n]/g, "");
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: scoped(key),
      Body: body,
      ContentType: contentType,
      ...(safeName ? { ContentDisposition: `attachment; filename="${safeName}"` } : {}),
    }),
  );
  return key;
}
