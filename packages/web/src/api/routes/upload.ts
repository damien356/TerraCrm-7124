import { z } from "zod";
import { authed, installerOnly } from "../middleware/auth";
import { installerLogoKey, mediaKey, signPut } from "../lib/s3";

/**
 * Presigned uploads. The file goes straight from the phone or the browser to
 * storage — it never passes through this server. The row in `job_media` is
 * written afterwards by `media.attach` (office) or `field.addMedia` (crew).
 */
export const upload = {
  presign: authed
    .input(
      z.object({
        jobId: z.number(),
        bucket: z.string().default("area"),
        filename: z.string().min(1),
        contentType: z.string().min(1),
      }),
    )
    .handler(async ({ input }) => {
      const key = mediaKey(input.jobId, input.bucket, input.filename);
      const url = await signPut(key, input.contentType);
      return { url, key };
    }),

  /** An installer's own business logo, not tied to any job. */
  presignInstallerLogo: installerOnly
    .input(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      const key = installerLogoKey(context.installerId, input.filename);
      const url = await signPut(key, input.contentType);
      return { url, key };
    }),
};
