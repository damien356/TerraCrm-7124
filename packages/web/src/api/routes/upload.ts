import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authed, installerOnly } from "../middleware/auth";
import { CREW_BUCKETS, installerOnJob } from "../lib/file-access";
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
    .handler(async ({ input, context }) => {
      // Field crew upload only to a job they are on, and only into the crew's own slots.
      if (context.actor.role === "field") {
        if (!(CREW_BUCKETS as readonly string[]).includes(input.bucket)) throw new ORPCError("FORBIDDEN", { message: "The crew can't add to that part of the job file." });
        if (!context.actor.installerId || !(await installerOnJob(context.actor.installerId, input.jobId))) throw new ORPCError("FORBIDDEN", { message: "You're not on this job." });
      }
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
