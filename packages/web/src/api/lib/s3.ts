import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

/** Upload straight from the phone or browser — never through the API server. */
export function signPut(key: string, contentType: string) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), {
    expiresIn: 900,
  });
}

/** Read links are short-lived and signed — job photos are not public. */
export function signGet(key: string, expiresIn = 3600) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
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
