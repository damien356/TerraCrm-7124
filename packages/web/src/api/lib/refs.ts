/* ---------------------------------------------------------------------------
 * How Terra numbers read (spec section 1). Pure, so the web pages and the
 * phone can use the same rules.
 *
 *   Job          188000            (old jobs 218 to 4447 keep their numbers)
 *   Quote        Q188000, revisions Q188000-2, Q188000-3
 *   Task         188000-A, 188000-B
 *   Repair       R188000-1          (old callbacks keep 3981-C1)
 *   PO           PO188000-1         (old POs keep 4113-A)
 *   Invoice      IQ188000-1 deposit, -2 final, -3 and up stages (section 2)
 *
 * The job, its quote, its invoices and its repairs all carry the job's own
 * number. A quote made before there is a job takes the next job number, and
 * the job made from it keeps that number.
 * ------------------------------------------------------------------------- */

/** The job as people read it, no "#": "188000", "R188000-1", old "3981-C1". */
export function jobText(j: { number: number; displayNumber?: string | null }) {
  return j.displayNumber || String(j.number);
}

/**
 * "Q188000", "Q188000-2". `jobRef` is the job's display ref when the quote is
 * on a job, so a quote on repair R188000-1 reads QR188000-1.
 */
export function quoteRef(number: number, version = 1, jobRef?: string | null) {
  const base = jobRef && /^R\d/.test(jobRef) ? jobRef : String(number);
  return `Q${base}${version > 1 ? `-${version}` : ""}`;
}

/** A, B ... Z, then AA, AB. */
export function taskLetter(seq: number | null | undefined) {
  let n = Math.max(1, Math.floor(Number(seq) || 1));
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" is 1, "Z" is 26, "AA" is 27. Null when it is not letters. */
export function taskSeqFromLetter(letter: string): number | null {
  const t = letter.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(t)) return null;
  let n = 0;
  for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** "188000-A". A task on a repair reads R188000-1-A. */
export function taskRef(jobRef: string | number, seq: number | null | undefined) {
  return `${jobRef}-${taskLetter(seq)}`;
}

/** "R188000-1". */
export function repairRef(parentNumber: number, seq: number) {
  return `R${parentNumber}-${seq}`;
}

/** "PO188000-1". */
export function poRef(jobNumber: number, n: number) {
  return `PO${jobNumber}-${n}`;
}

/** "IQ188000-1". Built with the invoices in section 2. */
export function invoiceRef(jobNumber: number, n: number) {
  return `IQ${jobNumber}-${n}`;
}

/**
 * A repair typed into search: "R188000-1", "r188000 1", and the old callback
 * forms "3981-C1", "3981c1", "#3981 C1". Returns the parent and the repair number.
 */
export function parseRepairRef(text: string): { parent: number; seq: number; old: boolean } | null {
  const t = text.trim();
  const r = t.match(/^#?\s*r\s*(\d+)\s*[-/ ]\s*(\d+)$/i);
  if (r) return { parent: Number(r[1]), seq: Number(r[2]), old: false };
  const c = t.match(/^#?\s*(\d+)\s*-?\s*c\s*(\d+)$/i);
  return c ? { parent: Number(c[1]), seq: Number(c[2]), old: true } : null;
}

/** "Q188000", "q188000-2", "Q-1042". Returns the number and version. */
export function parseQuoteRef(text: string): { number: number; version: number } | null {
  const m = text.trim().match(/^#?\s*q\s*-?\s*(\d+)(?:\s*[-/ v]\s*(\d+))?$/i);
  return m ? { number: Number(m[1]), version: m[2] ? Number(m[2]) : 1 } : null;
}
