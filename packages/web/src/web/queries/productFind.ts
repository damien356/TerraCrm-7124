import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import type { AppRouterClient } from "../../api";

type FindOut = Awaited<ReturnType<AppRouterClient["productFind"]["find"]>>;
export type FoundProduct = FindOut["rows"][number];
export type LastQuoted = Awaited<ReturnType<AppRouterClient["productFind"]["lastQuoted"]>>[number];

export type FindSort = "name" | "cheapest" | "dearest";

/** One search box for the supply pickers: words, type, thickness, sell range and sort. */
export function useProductFind(input: {
  search: string;
  category: string;
  thicknessMm: number | null;
  minSell: number | null;
  maxSell: number | null;
  sort: FindSort;
  limit?: number;
}, enabled = true) {
  return useQuery(
    orpc.productFind.find.queryOptions({
      input: { ...input, limit: input.limit ?? 40 },
      enabled,
      staleTime: 15_000,
      placeholderData: keepPreviousData,
    }),
  );
}

/** What each product's range was last quoted at. Empty for anyone who can't see costs. */
export function useLastQuoted(input: {
  productIds: number[];
  companyId?: number | null;
  contactId?: number | null;
  excludeQuoteNumber?: number | null;
}, enabled = true) {
  const ids = [...new Set(input.productIds)].sort((a, b) => a - b);
  return useQuery(
    orpc.productFind.lastQuoted.queryOptions({
      input: {
        productIds: ids,
        companyId: input.companyId ?? null,
        contactId: input.contactId ?? null,
        excludeQuoteNumber: input.excludeQuoteNumber ?? null,
      },
      enabled: enabled && ids.length > 0,
      staleTime: 60_000,
    }),
  );
}
