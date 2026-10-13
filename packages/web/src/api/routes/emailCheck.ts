import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { checkEmail } from "../lib/email-check";

/** Email check for every email field (format, typo, can the domain take mail). Logic in lib/email-check.ts. */
export const emailCheck = {
  /** Format, typo and mail server check for one email address. Never blocks a save. */
  check: staffOnly.input(z.object({ email: z.string().max(320) })).handler(({ input }) => checkEmail(input.email)),
};
