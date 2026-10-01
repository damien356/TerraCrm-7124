import { generateObject } from "ai";
import { z } from "zod";
import dedent from "dedent";
import { gateway } from "./gateway";

/**
 * VOICE MEMOS: the intent router.
 *
 * One recording in, a short list of things to do out. Damien records either
 * from inside a job or client card (the memo already knows who it is about) or
 * from the global mic button (it has to work that out from what he said).
 * Both land here and produce the same plan, so every action works from either
 * place.
 *
 * The model only PLANS. Nothing here writes to the database or sends anything.
 * `routes/memos.ts` executes the plan, and anything customer-facing comes back
 * as a draft that needs a tap.
 *
 * Same constraint as `extract.ts`: OpenAI structured output rejects `oneOf`,
 * so an action is one flat object with a `kind` tag and nullable fields.
 */

/* ---------------------------------------------------------------------------
 * Pass 1 (global memos only): who and what did he mention, so the route can
 * look up real candidates before planning.
 * ------------------------------------------------------------------------- */

export const mentionsSchema = z.object({
  personNames: z
    .array(z.string())
    .describe("Every customer or client name said, as said. Not Damien, not staff, not installers."),
  companyNames: z.array(z.string()).describe("Builder, agency or company names said."),
  phoneNumbers: z.array(z.string()).describe("Phone numbers said, digits only, e.g. 0412345678."),
  emails: z.array(z.string()).describe("Email addresses said."),
  jobNumbers: z.array(z.number()).describe("Job numbers said, e.g. 'job 4446' is 4446."),
  suburbs: z.array(z.string()).describe("Suburbs or street addresses said."),
});
export type Mentions = z.infer<typeof mentionsSchema>;

export async function findMentions(transcript: string): Promise<Mentions> {
  const { object } = await generateObject({
    model: gateway("openai/gpt-5.4"),
    schema: mentionsSchema,
    prompt: dedent`
      Pull every customer reference out of this voice memo from Damien, who runs
      Terra Flooring on the Gold Coast. Speech to text often mangles names, keep
      them as heard. Leave arrays empty when nothing was said.

      Memo:
      """
      ${transcript}
      """
    `,
  });
  return object;
}

/* ---------------------------------------------------------------------------
 * Pass 2: the plan.
 * ------------------------------------------------------------------------- */

export const ACTION_KINDS = [
  "note",
  "task",
  "reminder",
  "create_job",
  "quote",
  "email",
  "sms",
  "schedule",
  "job_status",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const memoActionSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  jobId: z
    .number()
    .nullable()
    .describe(
      "Id of the existing job (from the jobs listed below) this action is about. Null when it is about the client generally, or about a job this memo creates.",
    ),
  onNewJob: z
    .boolean()
    .describe("True when this action belongs to the job a create_job action in this same memo makes."),
  title: z
    .string()
    .nullable()
    .describe("task, reminder: short imperative, e.g. 'Call Jane Doe back on 0412 345 678'. create_job: the job title."),
  detail: z
    .string()
    .nullable()
    .describe("note: the note text, tidied. task, reminder: any extra detail. create_job: the job description."),
  dueDate: z.string().nullable().describe("task only: YYYY-MM-DD if a day was given, else null."),
  remindAt: z
    .string()
    .nullable()
    .describe("reminder only: local Gold Coast time as YYYY-MM-DDTHH:mm, worked out from the current time given."),
  quoteBrief: z
    .string()
    .nullable()
    .describe(
      "quote only: the part of the memo describing the work to price, kept close to what was said, with every product, colour, measurement, stair count and dollar figure.",
    ),
  subject: z.string().nullable().describe("email only: subject line, no job number."),
  body: z.string().nullable().describe("email, sms: the full message to the customer, ready to send."),
  bookingInstaller: z.string().nullable().describe("schedule only: installer name exactly as in the installer list."),
  bookingStartDate: z.string().nullable().describe("schedule only: YYYY-MM-DD."),
  bookingDays: z.number().nullable().describe("schedule only: days on site, null if not said."),
  bookingWindow: z.string().nullable().describe("schedule only: arrival window like '7-11' or '7am', null if not said."),
  statusId: z.number().nullable().describe("job_status only: id from the job status list."),
});
export type MemoAction = z.infer<typeof memoActionSchema>;

export const memoPlanSchema = z.object({
  summary: z.string().describe("One short line saying what the memo asks for, written to the speaker as 'you' and never using his name, e.g. 'New client Jane Doe, remind you to call her back in an hour'."),
  client: z.object({
    kind: z
      .enum(["context", "existing", "unsure", "new", "none"])
      .describe(
        "context: the memo was recorded on a client or job card. existing: clearly one of the candidates. unsure: probably a candidate but not certain. new: a person not in the candidates who should become a client. none: no client involved.",
      ),
    contactId: z.number().nullable().describe("existing or unsure: the candidate's contact id."),
    firstName: z.string().nullable().describe("new only."),
    lastName: z.string().nullable().describe("new only."),
    mobile: z.string().nullable().describe("new only, digits as said."),
    email: z.string().nullable().describe("new only."),
    address: z.string().nullable().describe("new only: street address."),
    suburb: z.string().nullable().describe("new only."),
    postcode: z.string().nullable().describe("new only."),
    notes: z.string().nullable().describe("new only: what they called about, in a sentence."),
  }),
  actions: z.array(memoActionSchema),
});
export type MemoPlan = z.infer<typeof memoPlanSchema>;

export interface PlanInput {
  transcript: string;
  /** e.g. "Thursday 1 October 2026, 2:05 pm (Gold Coast time)" plus ISO. */
  nowLocal: string;
  nowIso: string;
  /** Who is speaking, for the sign-off on messages. */
  speakerName: string;
  /** Set when recorded from a card. Plain text block. */
  context: string | null;
  /** Global memos: possible matches, plain text block. */
  candidates: string | null;
  installers: string[];
  statuses: { id: number; name: string }[];
}

export async function planMemo(input: PlanInput): Promise<MemoPlan> {
  const first = input.speakerName.trim().split(/\s+/)[0] || "Damien";

  const { object } = await generateObject({
    model: gateway("openai/gpt-5.4"),
    schema: memoPlanSchema,
    prompt: dedent`
      You are the office assistant inside Terra Ops, the job system for Terra
      Flooring, a flooring installer on the Gold Coast, Queensland. ${input.speakerName}
      just recorded a voice memo, often while driving. Turn it into a short list of
      actions. Do only what he asked for, nothing extra, but one memo can ask for
      several things.

      The time right now is ${input.nowLocal} (${input.nowIso}). Queensland has no
      daylight saving, it is always UTC+10. Work out "in an hour", "tomorrow
      morning", "Friday" and so on from this.

      ACTION KINDS
      - note: information to keep on the job or client record ("note that the
        dog is out the back", "she wants it done before Christmas"). If the memo is
        only information and asks for nothing, make a single note.
      - task: a to-do for the office with no set time. dueDate if a day was said.
      - reminder: anything with a time to be nudged ("remind me in an hour to
        call him", "call her back at 3"). remindAt is required. A bare "remind me
        to..." with no time means one hour from now. The title says exactly who
        to contact and how, including their number if he said one, because the
        reminder may pop up with nothing else on screen.
      - create_job: only when he asks to open, create or start a new job. title
        is short, like "Hybrid to living and hall". detail is the description.
      - quote: he describes work to be priced (products, areas, measurements,
        stairs, a dollar figure). quoteBrief carries that description.
      - email or sms: a message to the CUSTOMER. Write the whole message, ready
        to send, as ${first} from Terra Flooring. Australian English, warm, plain
        and short, the way a tradie writes to a homeowner. Use the real dates
        from the job details given below when he refers to them, and do the date
        maths yourself ("3 days later than the original date" means give the new
        date). Email body: greeting with their first name, the message, then
        "Thanks," and "${first}" and "Terra Flooring" on separate lines. SMS: one
        or two sentences, first name greeting, sign off "${first}, Terra
        Flooring", no opt-out wording (that is added later). Only make an SMS if
        he says text or SMS. Only make an email if he says email. If he says
        "message" or "let them know" with no channel, make an sms.
      - schedule: book an installer onto a job on a day. Use an installer name
        from the list. Needs a jobId.
      - job_status: move a job to a different status from the status list.

      WRITING RULES, FOR EVERY FIELD
      - Never use em dashes or en dashes. Use commas, full stops or shorter sentences.
      - Never invent facts, prices, dates or names he did not say or that are not
        in the details below. If a message needs something you do not have,
        write around it rather than guessing.

      THE CLIENT
      ${
        input.context
          ? dedent`
            This memo was recorded on the record below, so client.kind is "context"
            and everything is about this client. Do not look for anyone else.
            Pick the jobId from the jobs shown when an action is about a job. If
            the memo was recorded on a specific job, use that job's id.

            ${input.context}
          `
          : input.candidates
            ? dedent`
              This memo was recorded from the global button, so work out who it is
              about. Possible matches from the client list are below. Speech to text
              mangles names, so a near spelling with a matching suburb, phone or job
              counts. Choose "existing" only when it is clearly that person. Choose
              "unsure" with your best contactId when it could be them but you are
              not certain, or two candidates fit. Choose "new" when he describes
              someone who is not in the list (a new enquiry, "make a client", a
              name and number from a call) and fill in every detail he gave. Choose
              "none" when no customer is involved.

              ${input.candidates}
            `
            : dedent`
              This memo was recorded from the global button and nobody in the client
              list matched what was said. Choose "new" if he describes a person who
              should become a client and fill in every detail he gave, otherwise
              "none".
            `
      }

      Installers: ${input.installers.length ? input.installers.join(", ") : "(none)"}
      Job statuses (id: name): ${input.statuses.map((s) => `${s.id}: ${s.name}`).join(", ")}

      Voice memo:
      """
      ${input.transcript}
      """
    `,
  });

  return scrubPlan(object);
}

/** Belt and braces on Damien's rule: no long dashes anywhere a human reads. */
export function noDashes(text: string): string;
export function noDashes(text: string | null): string | null;
export function noDashes(text: string | null) {
  if (text == null) return null;
  return text
    .replace(/\s*[—―]\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/–/g, "-")
    .replace(/,\s*,/g, ",");
}

function scrubPlan(plan: MemoPlan): MemoPlan {
  return {
    ...plan,
    summary: noDashes(plan.summary),
    client: { ...plan.client, notes: noDashes(plan.client.notes) },
    actions: plan.actions.map((a) => ({
      ...a,
      title: noDashes(a.title),
      detail: noDashes(a.detail),
      subject: noDashes(a.subject),
      body: noDashes(a.body),
    })),
  };
}
