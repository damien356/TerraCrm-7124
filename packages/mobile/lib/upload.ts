import { client } from "@/lib/api";

/**
 * Photo and video go straight from the phone to storage. The API only ever
 * gets told the key afterwards, so a 40 MB walk-through video never has to
 * squeeze through the server.
 */
export async function uploadToStorage({
  uri,
  jobId,
  bucket,
  filename,
  contentType,
}: {
  uri: string;
  jobId: number;
  bucket: string;
  filename: string;
  contentType: string;
}) {
  const { url, key } = await client.upload.presign({ jobId, bucket, filename, contentType });
  const blob = await (await fetch(uri)).blob();
  const res = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error("Upload didn't go through. Check your signal and try again.");
  return { key, sizeBytes: blob.size };
}
