import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { installerOnly } from "../middleware/auth";
import { onMyWay, tickAptCheck } from "../lib/prep";
import { ownTaskOrThrow } from "./field";

/* ---------------------------------------------------------------------------
 * CLIENT PREP on the installer's phone (notes 18.56): On my way and the
 * apartment checklist. Only on the installer's own task.
 * ------------------------------------------------------------------------- */

export const fieldPrep = {
  /** Texts the client that I'm on the way. Once a day per client. */
  onMyWay: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.taskId, context.installerId);
    const r = await onMyWay(input.taskId, { name: context.actor.name || "Installer", installerId: context.installerId });
    if (!r.ok) throw new ORPCError("BAD_REQUEST", { message: r.reason ?? "Not sent. Call the client." });
    return { sent: r.sent, message: r.sent ? "Text sent to the client." : "Already sent today." };
  }),

  /** Fire alarm, lift, parking: ticked on site or by the office. */
  tickApt: installerOnly
    .input(z.object({ taskId: z.number(), key: z.enum(["fire", "lift", "parking"]), done: z.boolean() }))
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      return tickAptCheck(task.jobId, input.key, input.done, context.actor.name || "Installer", "field");
    }),
};
