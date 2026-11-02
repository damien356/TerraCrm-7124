import { z } from "zod";
import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { staffOnly } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { isCountedPack } from "../lib/pack-name";
import { editableQuoteOrThrow } from "./quotes";

/**
 * Pack name (Damien, 2 Nov). Per quote line, whether the client copy shows
 * m2 (the default) or the pack count: "10.80 m²" or "10 sheets". The line's
 * qty, price and total do not change, only how the client copy reads.
 */
export const quotePacks = {
  setClientPacks: staffOnly
    .input(z.object({ itemId: z.number(), packs: z.boolean() }))
    .handler(async ({ input }) => {
      const [line] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
      if (!line) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      await editableQuoteOrThrow(line.quoteId);
      const [p] = line.productId ? await db.select().from(schema.products).where(eq(schema.products.id, line.productId)) : [];
      if (input.packs && !isCountedPack(p)) {
        throw new ORPCError("BAD_REQUEST", { message: "This product is sold by the box. Only sheet, carton and bag products can show packs." });
      }
      const [row] = await db
        .update(schema.quoteItems)
        .set({ clientPacks: input.packs, updatedAt: new Date() })
        .where(eq(schema.quoteItems.id, line.id))
        .returning({ id: schema.quoteItems.id, clientPacks: schema.quoteItems.clientPacks });
      return row;
    }),
};
