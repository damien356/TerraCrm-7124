/**
 * REAL supplier data — not demo records. Every number here was read off the
 * supplier's own price list or fee schedule; nothing is estimated. Idempotent:
 * matches on `code`, updates in place, so it is safe to re-run after a
 * supplier changes a rate.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-suppliers.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";

type Fee = {
  name: string;
  kind: string;
  basis: string;
  amount?: number | null;
  percent?: number | null;
  amountIncludesGst?: boolean;
  isCredit?: boolean;
  autoApply?: boolean;
  condition?: string;
  sortOrder?: number;
  /** YYYY-MM-DD. The date the supplier's letter said it starts. */
  effectiveFrom?: string | null;
  /** YYYY-MM-DD, or null for UNTIL FURTHER NOTICE (the usual fuel-levy wording). */
  effectiveUntil?: string | null;
  notes?: string;
};

type SupplierSeed = {
  code: string;
  name: string;
  shipsFrom?: string;
  /**
   * false = they do NOT truck it to us. Chaparral hand off to Jocks Transport,
   * Big Panda do not deliver at all. Any delivery-kind fee on a supplier with
   * this off is held back from the order cost, because Terra is already paying
   * its own carrier for that leg and must not be billed twice.
   */
  deliversDirect?: boolean;
  freightMethod?: string;
  freightNote?: string;
  /** SUPERSEDED by a kind:"fuel" fee row. Display/history only. */
  fuelSurchargeActive?: boolean;
  fuelSurchargePct?: number;
  fuelSurchargeNote?: string;
  dealerPricingEligible?: boolean;
  dealerPricingNote?: string;
  priceListEffectiveFrom?: string;
  priceListValidUntil?: string;
  priceListSource?: string;
  notes?: string;
  fees: Fee[];
};

const SUPPLIERS: SupplierSeed[] = [
  {
    code: "terramater",
    name: "Terramater",
    shipsFrom: "South Australia",
    fuelSurchargeActive: true,
    fuelSurchargePct: 2,
    fuelSurchargeNote: "Currently 2% of the order. Was 1.2% — supplier raised it. Confirm on each order.",
    priceListEffectiveFrom: "2025-04-01",
    priceListSource: "Terramater_Price_List_2025_.pdf",
    notes:
      "13 flooring ranges (engineered timber, hybrid, vinyl, laminate). One price per range, colours inherit it. Prices per m2 ex-GST, freight excluded.",
    fees: [
      {
        name: "Baling / handling",
        kind: "baling",
        basis: "order",
        amount: 30,
        amountIncludesGst: false,
        autoApply: true,
        condition: "$30 + GST per order",
        sortOrder: 10,
      },
      {
        name: "Delivery to Gold Coast warehouse",
        kind: "delivery",
        basis: "order",
        amount: 100,
        autoApply: true,
        condition: "Ex South Australia into Terra's Gold Coast warehouse — $100 per order",
        sortOrder: 20,
      },
    ],
  },
  {
    code: "riverhill",
    name: "Riverhill",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-09-25",
    priceListSource: "Riverhill 2025 Product Price List (owner-supplied workbook, effective from 25 Sep 2026)",
    notes:
      "8 flooring ranges (engineered timber, SPC hybrid). One price per range, colours inherit it. Prices per m2 ex-GST, confirmed exact, not rounded. NO baling charge — confirmed by the owner and stated on the supplier's own sheet. DOES NOT DELIVER to the Gold Coast warehouse: Terra books its own carrier (Unified or Jocks), so there is deliberately no delivery fee row here. Trim availability is per-range and several ranges have no trims at all.",
    fees: [],
  },
  {
    code: "sunstar",
    name: "Sunstar Flooring",
    fuelSurchargeActive: false,
    fuelSurchargeNote: "No fuel surcharge — confirmed by the owner. Nothing on the supplier's sheet either.",
    priceListEffectiveFrom: "2026-03-01",
    priceListSource: "Sunstar QLD Commercial March 2026 Product Price List (owner-supplied workbook)",
    notes:
      "24 live flooring ranges across engineered timber, Australian hardwood, hybrid, laminate and luxury vinyl plank (235 colour codes). One price per range, colours inherit it. Prices per m2 ex-GST. NO baling charge — the supplier's own sheet states none is charged. DELIVERS to the Gold Coast warehouse itself at $110 + GST per pallet (QLD metro), so Terra's own carriers are not needed for warehouse orders. Two further ranges (Prism, Prism Herringbone) are held out until Sunstar publishes codes and colours, expected Q2 2026. Stair nosings are priced per named range, not universal, and trim coverage is broad. Custom Stair Nosing is price-on-application: quote from Sunstar Orders, allow 10 days for manufacture and delivery.",
    fees: [
      {
        name: "Delivery to Gold Coast warehouse",
        kind: "delivery",
        basis: "pallet",
        amount: 110,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$110 + GST per pallet, QLD metro only (zone set by Sunstar's couriers), forklift unloading. Hand unloading and regional deliveries are by quote. Terra must supply the unloading equipment and flag up front if it cannot unload a 1 tonne pallet.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "airlay",
    name: "Airlay",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2025-01-01",
    priceListSource: "Airlay QLD January 2025 Price List (owner-supplied workbook, colours expanded from airlay.com.au)",
    notes:
      "27 ranges across carpet tile, carpet plank, sheet vinyl, vinyl plank, vinyl tile, laminate and hybrid (325 colour lines). Jan 2025 pricing CONFIRMED STILL CURRENT by the owner despite its age. First supplier where price is NOT one-per-range: it varies by backing (PVC, Cushion Back +$6, PU Cushion Back +$8 — three genuinely different backings), by size (Alpine), by thickness (Rustic 8mm vs 12mm) and per colour (Corporate, 8 colours at 8 prices). First supplier with ROLL GOODS: 7 sheet vinyl ranges, 2.0m x 20m, 40 m2/roll, priced per m2, with R10/R11/R12 slip ratings — rolls must go on Jocks, and sheet vinyl quotes need a linear-metre cut plan, not pack maths. No product codes anywhere, so product identity needs a generated composite key. Range names collide across categories (Oakwood is both vinyl plank and hybrid), so range keys must be unique per category. Rustic 8mm board size corrected to 1227 x 194 by the owner; the supplied 1215 did not reconcile. 33 rows carry a supplier 'selected colours' note: imported as normal, availability checked at order time. 7 Empire Plank colours are made to order.",
    fees: [
      {
        name: "Metropolitan delivery bundling fee",
        kind: "delivery",
        basis: "order",
        amount: 85,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$85 + GST per delivery into Terra's Gold Coast warehouse — auto-applies to warehouse orders only. Forklift-equipped metropolitan deliveries, minimum 72 hours notice. Site deliveries go via Terra's own carriers instead, so do not apply this fee to them.",
        sortOrder: 10,
      },
      {
        name: "Sheet vinyl cutting fee",
        kind: "cutting",
        basis: "order",
        amount: 30,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "$30 + GST per cut, charged per cut rather than per order — multiply by the number of drops in the cut plan. Sheet vinyl only.",
        sortOrder: 20,
      },
    ],
  },
  {
    code: "chameleon",
    name: "Chameleon Flooring",
    shipsFrom: "Brisbane",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2025-03-01",
    priceListSource:
      "Terra Flooring March 2025 Wholesale Price List (owner-curated workbook). The workbook's own Source Notes sheet names the supplier as Chameleon Flooring Pty Ltd — this is the confirmation that the PDF alone never gave.",
    notes:
      "9 priced product lines across 4 families — ELSA, ELSA Plus, ELSA Plus XL (luxury vinyl plank) and Pallas (SPC hybrid) — 82 colour lines. THE PRICED ENTITY IS THE PRODUCT LINE, NOT THE FAMILY: Pallas alone runs four different rates ($28 Pallas 7.5mm, $33 Pallas Ultimate 9mm, $33 Pallas Deluxe Herringbone, $35 Pallas QUANTUM), so a quote must name the product line, never just 'Pallas'. Prices per m2 ex-GST. No product codes published at all, so product identity is a generated composite key. ORDER OFF THE BOARD COUNT: Elsa Plus XL prints 2.601 m2/pack where 8 boards is truly 2.5937, so the printed figure under-orders by about 0.3%. GOODS ARE EX BRISBANE and the list quotes no delivery rate — like Riverhill, Terra books its own carrier, so there is deliberately no delivery fee row here. PALLAS QUANTUM'S $35 DID NOT COME OFF THE DOCUMENT — it was supplied by the owner and its wear layer is blank on the sheet; those 8 rows carry that provenance. ELSA Max and several other ranges on the original PDF were deliberately excluded by the owner, so a gap here is a decision, not missing data. TRIMS FIT BY CORE TYPE (WPC / SPC / Vulcan), which is not a column on the flooring sheet — most trims therefore carry a confirm-the-core warning rather than a range match, and 'Vulcan' is not a retained range at all. PRICES ARE MARCH 2025, ABOUT 18 MONTHS OLD — re-confirm with Chameleon before quoting off them.",
    fees: [
      {
        name: "Warehouse / admin fee",
        kind: "handling",
        basis: "order",
        amount: 50,
        amountIncludesGst: false,
        // DELIBERATELY NOT AUTO-APPLIED. The Source Notes sheet gives the $50
        // figure with no basis — per order, per pallet and per delivery are all
        // consistent with what is written. Auto-applying an unconfirmed basis
        // would quietly put the wrong number on every Chameleon quote, so the
        // office adds it by hand until Chameleon confirms which it is.
        autoApply: false,
        condition:
          "$50 + GST, from the price list's own Source Notes. BASIS UNCONFIRMED — the document states the amount but not whether it is per order, per pallet or per delivery, so this does not auto-apply. Confirm with Chameleon, then set the basis and turn auto-apply on.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "belgotex",
    name: "Belgotex",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-07-03",
    priceListSource: "Belgotex carpet tiles Sep 2026 + broadloom price list 03/07/2026",
    notes:
      "Two current lists: carpet tiles (Sep 2026, priced per m2, price varies by BACKING - Flexbac / ProBac / Cushion Back / PVC) and broadloom carpet (03/07/2026, priced per LINEAR METRE at 4.0m, wool at 3.66m, one price per range). First supplier with real clearance pricing: 35 carpet-tile variants across 7 ranges carry a clearance price with an end date, all on Flexbac backing. Clearance reverts to the standard price automatically on the day after it ends. Baling differs by product: $50 per pallet on tiles, $35 per roll on broadloom. FREE delivery into store; NO site delivery offered. Broadloom minimum order 2.0 lm.",
    fees: [
      {
        name: "Handling / baling — carpet tiles",
        kind: "baling",
        basis: "pallet",
        amount: 50,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$50 + GST per pallet on carpet tiles. Charged per pallet, so it multiplies on a big tile order.",
        sortOrder: 10,
      },
      {
        name: "Broadloom baling",
        kind: "baling",
        basis: "roll",
        amount: 35,
        amountIncludesGst: false,
        autoApply: true,
        condition: "$35 + GST per roll of broadloom carpet. Per roll, not per order.",
        sortOrder: 20,
      },
      {
        name: "Requested cut",
        kind: "cutting",
        basis: "order",
        amount: 25,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "$25 + GST per cut, and ONLY when Terra asks for the cut. Cuts Belgotex initiates are free, so tick this on per requested cut.",
        sortOrder: 30,
      },
      {
        name: "FIS delivery into store",
        kind: "delivery",
        basis: "order",
        amount: 0,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "FREE into store from the originating city. Regional is free to the customer's freight forwarder. Confirmed $0, not a blank — Belgotex does not charge Terra to deliver into the store. No site delivery: Belgotex quotes it on application and Terra does not use it, so site drops go on Terra's own carriers.",
        sortOrder: 40,
      },
    ],
  },
  {
    code: "polyflor",
    name: "Polyflor",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-09-26",
    priceListSource: "Polyflor_Master_Runable_Final_DTNNP6.xlsx (owner-supplied master workbook)",
    notes:
      "23 ranges / 474 colour lines across LVT, Commercial Sheet and Safety Sheet. All prices per m2 ex-GST. " +
      "TWO PRICE COLUMNS on the supplied list: where a Discount price exists it IS Damien's everyday cost, so it is " +
      "loaded as the STANDARD cost, not a special — it has no end date and never reverts (408 lines). Where the " +
      "Discount column is blank the Trade price is the standard cost (36 lines: Expona Simplay, Expona Design, " +
      "Expona Control). Camaro PUR (30 colours) is blank in both columns; Damien supplied $38.77/m2 directly. " +
      "FIRST SUPPLIER WITH ROLL-vs-CUT PRICING: all 274 sheet-vinyl lines carry a roll rate AND a higher cut rate " +
      "for part rolls off a 2m x 20m (40 m2) roll. Over a full roll the WHOLE quantity bills at the roll rate, " +
      "offcut included; under a roll everything bills at the cut rate. Resolved per quote line by resolveRollCut() " +
      "in api/lib/pricing.ts, which also flags when taking the whole roll is cheaper than the cut being asked for. " +
      "Product codes are NOT globally unique on this list — code 4020 is both Polysafe Standard PUR / Silver Birch " +
      "and Expona Commercial PUR / Grey Ash — so codes are stored as the SKU but identity is the variant key. " +
      "Weld rod is a sellable accessory at $2.20 per lineal metre and sits in the price book, not here.",
    fees: [
      {
        name: "Freight",
        kind: "delivery",
        basis: "order",
        amount: 80,
        amountIncludesGst: false,
        autoApply: true,
        condition: "$80 + GST per delivery. Damien: every Polyflor order carries it, so it auto-applies.",
        sortOrder: 10,
      },
      {
        name: "Baling fee",
        kind: "baling",
        basis: "roll",
        amount: 20,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$20 + GST PER ROLL, as the supplier's sheet states — it multiplies on a multi-roll order, it is not a flat $20 an order. Auto-applies; only sheet-vinyl rolls attract it, boxed LVT does not.",
        sortOrder: 20,
      },
    ],
  },
  {
    code: "hurfords",
    name: "Hurford's",
    // Superseded by the kind:"fuel" fee row below, kept in step with it so the
    // supplier card cannot read "no surcharge" while a live 2.21% rule sits
    // underneath. Display only, no money goes through these.
    fuelSurchargeActive: true,
    fuelSurchargePct: 2.21,
    fuelSurchargeNote:
      "2.21% of the goods on the order, ex GST, from 23 Sep 2026. Damien: \"Effective 23.09.2026 there will be an added 2.21% fuel surcharge to all orders\", and asked which lists it covers, \"All orders including solid, plywood and engineered\". No end date given. Held as a percent_of_order fee rule so it switches off in one place.",
    priceListEffectiveFrom: "2025-06-01",
    priceListSource: "Hurfords_CD_Non_Structural_Pine_Plywood_Runable_isvB_D.xlsx",
    notes:
      "CD NON-STRUCTURAL pine plywood, 8 thicknesses 7-25mm, all 2400 x 1200mm sheets. " +
      "THIS IS THE STRAIGHT-TO-SLAB SHEET — an overlay. It CANNOT span joists. Damien: Hurford's do make a " +
      "joist-rated sheet but it costs more than Mitre 10's, so the joist work goes to Mitre 10 and Hurford's " +
      "covers slab overlay. The two are not substitutes however close the $/sheet looks. " +
      "FIRST PACK-vs-LOOSE SUPPLIER: every thickness has a pack rate at a full pack and up, and a higher loose " +
      "rate below it (+8% nominal). A pack is a fixed HEIGHT of timber, about 500-545mm, which is why the break " +
      "falls from 75 sheets at 7mm to 20 sheets at 25mm. Loose rates are Hurford's OWN printed figures, not 8% " +
      "applied in code — three of the eight miss a flat 8% by a cent — so they are stored explicitly. Resolved " +
      "per quote line by resolveRollCut() with bulkKind 'pack' in api/lib/pricing.ts, same engine as vinyl " +
      "roll-vs-cut, which also flags when a full pack is CHEAPER than the loose quantity asked for. " +
      "PLYWOOD PRICE LIST IS FROM JUNE 2025 — over a year old, re-confirm before a large order. " +
      "THREE SEPARATE LISTS FROM THE ONE SUPPLIER, AND THEY ARE DATED DIFFERENTLY: the plywood list above runs " +
      "from June 2025, the ENGINEERED FLOORING list from 1 April 2025, and the SOLID FLOORING list from " +
      "12 February 2026, which is the freshest of the three. The supplier date below is the plywood one and " +
      "every flooring row carries its own list date in `sourceNote`, the same reason Mitre 10's two quotes are " +
      "dated per product. " +
      "ENGINEERED TIMBER FLOORING IS NOW IN, which closes the question this note used to leave open: it prices " +
      "PER m2, not per lineal metre. 163 colour/length rows across 17 ranges, 23 rates from $56.00 to " +
      "$115.00/m2 ex GST, plus 5 Genuine Oak nosings and mitres and 2 foam underlays. Ranges are Australian " +
      "Native and First Floors in Australian hardwood, Genuine Oak, Naked Oak, HM Walk, and the handed " +
      "herringbone and chevron parquetry. " +
      "DELIVERY INTO TERRA'S WAREHOUSE IS FREE ON ALL THREE LISTS AND THAT IS THE DEFAULT. Damien: \"they " +
      "don't charge for delivering to my warehouse\", with no minimum order to earn it, because Terra unload " +
      "with their own forklift and need no crane truck and no tailgate. Hurford's do deliver themselves, so " +
      "`deliversDirect` stays true. " +
      "SOLID TIMBER IS THE ONE LIST WITH REAL FREIGHT ON IT, WHICH CORRECTS WHAT THIS NOTE USED TO SAY. The " +
      "plywood and the engineered lists print no freight at all, but the solid rules sheet does: a crane truck " +
      "to site is a FLAT $320 ex GST a delivery for Brisbane and the Gold Coast, whatever the load, and it is " +
      "on file as a fee rule that does NOT auto-apply, because the free warehouse run is the normal case. " +
      "Terra only send solid to site on an order OVER 10 m2, which is Terra's own operational rule rather than " +
      "a Hurford's published one and covers solid flooring only. The $450 Sunshine Coast crane rate is " +
      "recorded for reference and is not relevant to Terra. So is the printed $80 first pack plus $15 a pack " +
      "thereafter, which prices a yard or depot delivery Terra does not buy. " +
      "A 2.21% FUEL SURCHARGE RUNS FROM 23 SEP 2026 AND IT IS SUPPLIER-WIDE. Damien: \"Effective 23.09.2026 " +
      "there will be an added 2.21% fuel surcharge to all orders\", and on which lists it covers, \"All orders " +
      "including solid, plywood and engineered\". So it is charged on the plywood and on the engineered " +
      "flooring alike, and it is seeded once against the supplier rather than per list. It is 2.21% of the " +
      "GOODS ex GST, so it does not compound on the $80 broken pack fee, and the two stack independently: an " +
      "order short of a pallet carries both. It is worth $1.24/m2 at the cheapest flooring rate of $56.00 and " +
      "$2.54/m2 at the dearest of $115.00, $1.94 on First Floors Blackbutt 135mm at $88.00, and $1.01 a sheet " +
      "on 17mm plywood at the $45.62 pack rate. IT IS NOT IN ANY SEEDED PRICE, on purpose, so the day " +
      "Hurford's drop it one fee row comes off instead of 730 rates being re-imported. NO END DATE WAS GIVEN, " +
      "which is the supplier declining to name one, not a promise that it is permanent. " +
      "SOLID TIMBER FLOORING IS NOW IN, which closes the question this note used to leave open when \"solid\" " +
      "appeared in Damien's fuel surcharge answer with no list behind it. 552 rows off the QLD Solid Flooring " +
      "list effective 12 February 2026, across 8 ranges and 34 species. " +
      "IT PRICES PER LINEAL METRE, NOT PER m2, WHICH IS THE OPPOSITE OF THE ENGINEERED LIST. 495 board rows " +
      "carry 138 rates from $3.57 to $29.88 a lineal metre, the board width is carried in `widthM` so the app " +
      "can still show m2, and both columns are printed and agree to within 0.5% on every row. The 57 parquetry " +
      "rows are the exception and price per m2, 28 rates from $39.57 to $231.93, because a parquetry block has " +
      "no lineal run. " +
      "GRADE IS THE PRICE LEVER ON THIS LIST. 517 of the 552 rows are one of 2 or 3 grades of the same board " +
      "at the same size and profile, so a quote that does not name the grade is a guess. Every row carries its " +
      "board's full grade spread in its notes for that reason. " +
      "THE PRODUCT CODE COMES WITH THE GRADE PUNCHED OUT OF IT: 529 codes print '##' where the two-letter " +
      "grade code belongs, 9 of them a single '#' typo in the same slot. The row's own grade is substituted " +
      "back in to give the orderable code, which produces 552 codes with no collisions, and the printed " +
      "template is kept beside it so an invoice matches either way. " +
      "109 ROWS PRINT NO PACK SIZE AND THAT IS THE PRODUCT, NOT A GAP. Overlay T&G 83 x 12 and Overlay T&G " +
      "FOURTEEN+ 85 x 14 are natural timber supplied in random lengths from 1 m to 6 m, per Damien, so there " +
      "is no pack quantity to print. `rollM2` is left null on purpose and never assumed to be 400. " +
      "ONE ROW IS PRICE ON APPLICATION: FECYPN062020, Cypress Pine 62 x 20, prints no rate at all where the " +
      "other five Cypress sizes print both. Seeded POA rather than filled in from the neighbouring 85 x 20. " +
      "Ask Hurford's whether the size is still made. " +
      "NOT PRINTED ON THE SOLID LIST AND NOT INVENTED: janka, moisture content, coating, warranty and lead " +
      "times. " +
      "THE $80 IS A BROKEN PACK FEE, NOT DELIVERY. It is charged when the order does not make a full pallet. " +
      "This CORRECTS an earlier reading of the same $80 as a flat delivery charge: the money is identical on a " +
      "short order and the trigger is completely different, so a full-pallet order now carries NOTHING where " +
      "before it carried $80. " +
      "IT IS ONE $80 AN ORDER, NOT ONE PER SHORT LINE. The flooring sheet prints $80 against every one of the " +
      "163 rows and describes it two incompatible ways in the one rule: $80 'once per order' AND $80 'when " +
      "quantity for that product is less than one full pallet'. Those bill differently, and on a three-line " +
      "order short of a pallet the per-product reading takes $240. Damien settled it: $80, once, for being " +
      "under a pallet. It is seeded once as a handling fee rule and appears on no product row, so anyone " +
      "re-importing that workbook must not seed the per-row column as a second charge. " +
      "THE FEE IS ORDER-LEVEL, SO A FULL-PALLET LINE DOES NOT ESCAPE IT. Damien confirmed a line that does " +
      "make a pallet still sits under the fee when it shares an order with a short line — the test is whether " +
      "the ORDER makes a pallet, not each line. Only an order that is all full pallets avoids the $80. " +
      "THE SOLID LIST'S \"$80 JOB LOT FEE\" IS THE SAME $80, NOT A SECOND ONE. Its rules sheet words it as a " +
      "job lot fee for less than full pack quantities, which is the broken pack fee described differently, the " +
      "same way the engineered workbook's per-row Job Lot Fee column is. So there is ONE $80 handling rule on " +
      "this supplier covering all three lists, and a mixed order short of a pallet carries $80 once and not " +
      "$160. Damien confirmed it still lands even though delivery into the warehouse is free: the $80 is " +
      "handling, not freight, so a free delivery does not wash it off. " +
      "BOXED PARQUETRY IS THE ONE EXCEPTION AND IT IS DEARER: $150 ex GST broken pack INSTEAD OF the $80, not " +
      "on top of it, so a parquetry line short of a full box quantity carries $150 and the $80 comes off. The " +
      "other two figures the parquetry rules print, a $150 freight fee and a $80 freight surcharge, are " +
      "FREIGHT and so $0 into Terra's warehouse. " +
      "THE RATE COLUMN IS HEADED 'PALLET PRICE $/m2' AND NOW THAT HEADING MAKES SENSE: the printed rate IS the " +
      "pallet rate, and going under a pallet costs the $80 fee rather than a higher rate per m2. There is still " +
      "only ONE rate per row. No broken-pallet or loose RATE is printed anywhere on the list, so no cut rate " +
      "and no volume break is seeded and every quantity quotes at the printed rate, with the shortfall priced " +
      "by the fee instead. This is the opposite shape to the plywood above, which charges a higher loose RATE " +
      "per sheet and no fee. If Hurford's ever do quote a broken-pallet rate it belongs in `cutCostPrice` with " +
      "`rollM2` set to the pallet m2, and the fee rule comes off. " +
      "FULL PALLET m2 IS DERIVED AND IT NOW DECIDES MONEY. The workbook's own column for it is blank on all 163 " +
      "rows, so it is computed as boards a box x board m2 x boxes a pallet. It runs 69.12 to 119.84 m2 a pallet " +
      "depending on the board, and that figure is the $80 threshold, so it is worth confirming with Hurford's " +
      "on any order sitting close to a full pallet. " +
      "HERRINGBONE AND CHEVRON ARE SOLD HANDED, LEFT AND RIGHT AS SEPARATE BOXES, and a job needs both. 26 rows " +
      "are one hand of a pair and each names its opposite number. Quoting one hand only is half a floor. " +
      "ONE ACCESSORY CODE IS A TEMPLATE, NOT A CODE: the Genuine Oak standard mitre is printed 'NOS**1000302.2' " +
      "with a literal ** where the colour code goes, because it comes in every Genuine Oak colour. Kept verbatim " +
      "with the gap flagged rather than filled in with a guess — the office fills it at order time. " +
      "FLOORING PRICES CONFIRMED CURRENT BY DAMIEN despite the April 2025 date, so they are seeded with no " +
      "stale-price flag. " +
      "NOT PRINTED ON THE FLOORING LIST AND NOT INVENTED: warranty, acoustic rating, janka, moisture content, " +
      "lead times and stock position. The lamella is printed on all but 4 First Floors rows, which are left " +
      "null. Worth asking for the lamella on those and for lead times generally.",
    fees: [
      {
        name: "Broken pack fee",
        // Handling, not delivery. Hurford's deliver to Nerang for nothing, so
        // a freight-kind rule here would invent a charge that does not exist.
        kind: "handling",
        basis: "order",
        amount: 80,
        amountIncludesGst: false,
        // Auto-applies because a Hurford's pallet is 69-120 m2 and a Terra job
        // is almost never that big, so short of a pallet is the normal case.
        // The exception is named in the condition so the office knows when to
        // take it off, which is safer than a charge that silently goes missing.
        autoApply: true,
        condition:
          "$80 EX GST ONCE AN ORDER WHEN THE ORDER DOES NOT MAKE A FULL PALLET OR FULL PACKS. Confirmed by Damien: \"they charge broken pack fee for under a pallet but they don't charge for delivering to my warehouse\". TAKE IT OFF an order that is all full pallets, which is the only case that avoids it. DO NOT MULTIPLY IT BY THE SHORT LINES: it is one $80 on the order however many products are short, so a three-line short order is $80 and not $240. A line that does make a pallet does not escape it either, per Damien, because the test is whether the order makes a pallet. " +
          "THIS ONE RULE COVERS ALL THREE LISTS. The engineered workbook's per-row \"Job Lot Fee\" column and the solid rules sheet's \"$80 job lot fee for less than full pack quantities\" are this same charge worded differently, not extra ones, so neither is ever added again per product line and a mixed short order carries $80 once, not $160. " +
          "IT IS HANDLING, NOT FREIGHT, SO FREE DELIVERY DOES NOT WASH IT OFF. Delivery into Terra's warehouse is $0 on every list and this $80 still lands, which Damien confirmed on the solid list. Freight lives in its own rule below and only exists on solid timber. " +
          "BOXED PARQUETRY PAYS $150 INSTEAD, per the rule below. Where that one is ticked on, this $80 comes off: they replace each other, they do not stack. " +
          "A full pallet is 69-120 m2 depending on the board and the workbook never prints it, so the threshold is derived per product.",
        sortOrder: 10,
      },
      {
        name: "Crane truck delivery to site",
        // The only freight-shaped charge on this supplier, and it exists on the
        // solid timber list alone: the plywood and engineered lists print none.
        kind: "delivery",
        // Per delivery, not per pack and not per m2. Hurford's print $320 flat
        // whatever the load, so a bigger order does not cost more to send.
        basis: "shipment",
        amount: 320,
        amountIncludesGst: false,
        // NEVER auto-applies. The default on every Hurford's order is the free
        // run into Terra's warehouse, so an automatic $320 would invent freight
        // on the normal case. The office ticks it on for a site drop.
        autoApply: false,
        condition:
          "$320 EX GST A DELIVERY, FLAT, AND ONLY WHEN SOLID TIMBER GOES STRAIGHT TO SITE. Brisbane and Gold Coast rate, whatever is on the truck, so it does not scale with the order. " +
          "THE DEFAULT IS $0, NOT THIS. Delivery into Terra's warehouse is free on all three Hurford's lists because Terra unload with their own forklift and need no crane truck and no tailgate, so leave this OFF unless the order is being craned to site. " +
          "TERRA ONLY SEND TO SITE OVER 10 m2. Damien: \"They deliver to us for free but if we get site delivery it's for only over 10m2.\" That threshold is Terra's own operational rule, not a Hurford's published one, and it applies to Hurford's SOLID flooring only: under 10 m2 the job is collected or run out of the warehouse. It is guidance for the office and overridable per order. " +
          "SOLID TIMBER ONLY. Nothing freight-shaped is printed on the plywood or the engineered flooring lists, so this rule never belongs on an order of those.",
        notes:
          "THE SOLID RULES SHEET PRINTS FOUR FREIGHT FIGURES AND ONLY THIS ONE IS TERRA'S. On file for reference, never auto-applied: $450 + GST for a crane truck to the Sunshine Coast, which is outside Terra's area; $80 + GST the first pack then $15 + GST a pack thereafter, which prices a yard or depot delivery Terra does not buy; and a $150 freight fee plus a $80 freight surcharge on boxed parquetry, both of which are freight and so $0 into the warehouse. " +
          "THE PER-PACK FIGURE IS WHY THE 109 RANDOM-LENGTH ROWS CANNOT BE FREIGHTED ON PAPER. Overlay T&G 83 x 12 and Overlay T&G FOURTEEN+ 85 x 14 print no pack size because they come in random lengths, so a per-pack freight quote on them has to come from Hurford's directly. It does not affect a warehouse order, which is free, or a site order, which is flat.",
        sortOrder: 15,
      },
      {
        name: "Parquetry broken pack fee",
        // Handling like the $80, and it REPLACES the $80 rather than adding to
        // it, which is why both sit as manual-and-auto opposites: the $80 auto
        // applies and the office swaps this in on a parquetry line.
        kind: "handling",
        basis: "order",
        amount: 150,
        amountIncludesGst: false,
        // Not auto: only boxed parquetry attracts it, which is 57 of the 552
        // solid rows and none of the other two lists, so auto-applying would
        // charge it on every board order.
        autoApply: false,
        condition:
          "$150 EX GST ON A BOXED PARQUETRY ORDER SHORT OF FULL BOX QUANTITIES, AND IT REPLACES THE $80 BROKEN PACK FEE RATHER THAN STACKING ON IT. Tick this on and take the $80 off, so a short parquetry order is $150 and not $230. " +
          "BOXED PARQUETRY ONLY: the 57 parquetry rows on the solid timber list, supplied to the nearest box. None of the 495 board rows, no engineered row and no plywood sheet attracts it. " +
          "IT IS HANDLING, NOT FREIGHT. The parquetry rules also print a $150 freight fee and a $80 freight surcharge and BOTH ARE $0 into Terra's warehouse, so do not read this $150 as the freight one. A parquetry order craned to site carries this $150 and the $320 site delivery together.",
        sortOrder: 16,
      },
      {
        name: "Fuel Surcharge",
        kind: "fuel",
        // Percent basis, so `percent` carries the rate and `amount` stays null.
        // The engine reads it as a percentage of the ex-GST GOODS, which is
        // what Hurford's charge it on: it does not compound on the $80 above.
        basis: "percent_of_order",
        percent: 2.21,
        amount: null,
        amountIncludesGst: false,
        // Damien said "all orders", with no threshold and no exemption, so it
        // auto-applies. It stacks with the broken pack fee, which is a
        // different kind on a different basis, and the two sum independently.
        autoApply: true,
        // Damien's own date, stated as 23.09.2026. Already past as at 27 Sep
        // 2026, so the rule is live from the moment it is seeded.
        effectiveFrom: "2026-09-23",
        // NULL = until further notice. Hurford's named no end date.
        effectiveUntil: null,
        condition:
          "2.21% + GST OF THE GOODS EX GST ON EVERY HURFORD'S ORDER, FROM 23 SEP 2026. Damien: \"Effective 23.09.2026 there will be an added 2.21% fuel surcharge to all orders\". " +
          "IT COVERS ALL THREE LISTS. Asked whether it was flooring, plywood or everything, Damien said \"All orders including solid, plywood and engineered\", so it is charged on the plywood, the engineered flooring and the solid flooring alike and it is seeded once on the supplier, not per list. " +
          "IT IS PERCENT OF GOODS, NOT OF THE ORDER TOTAL, so it does NOT compound on the $80 broken pack fee. A short order carries both: 20 m2 of First Floors Blackbutt 135mm at $88.00 is $1,760.00 of goods, $38.90 of fuel and $80.00 broken pack, $1,878.90 ex GST. " +
          "NO END DATE WAS GIVEN, so it runs until further notice. Ask on each order whether it still applies, and if it changes, change the percent here rather than the 730 seeded rates.",
        notes:
          "HELD AS A FEE RULE, NOT BAKED INTO PRICES, for the same reason as Tarkett's 2.1%: switching it off is one row, re-importing two price lists is not. " +
          "Backdated by 4 days at seed time, 23 Sep against a 27 Sep seed, which is Damien relaying it after it started rather than a projection. Any Hurford's order placed on or after 23 Sep owes it, including one quoted before that date, so re-check anything quoted in the week either side. " +
          "\"Solid\" in Damien's answer now has a list behind it: the 552-row QLD Solid Flooring list effective 12 February 2026 is seeded, so all three lists he named are priced and this 2.21% sits across the lot. It is charged on the GOODS, so on a solid order it does not compound on the $80 broken pack fee, the $150 parquetry fee or the $320 crane truck either.",
        sortOrder: 20,
      },
    ],
  },
  {
    code: "mitre10",
    name: "Woodmans Mitre 10 Beenleigh",
    shipsFrom: "Beenleigh QLD",
    priceListEffectiveFrom: "2026-09-21",
    // The STRUCTURAL PLY quote. The mouldings quote expired months ago and is
    // carried per product in `priceValidUntil`, because one supplier date
    // cannot describe two quotes with two different expiries.
    priceListValidUntil: "2026-10-21",
    priceListSource: "Mitre_10_Woodman_Beenleigh_Plywood_and_Mouldings_K_GTn4.xlsx",
    notes:
      "A trade store QUOTE, not a standing price list — every line lapses. Two quotes on the one document: " +
      "structural plywood dated 21 Sep 2026 and valid to 21 Oct 2026, and mouldings quote 6431308 dated " +
      "13 May 2026 which EXPIRED 12 Jun 2026. The mouldings prices are therefore STALE and must be re-quoted " +
      "before they go on a customer quote; the expiry is stored per product, not per supplier. " +
      "PLYWOOD IS F8 STRUCTURAL WITH A T&G EDGE — Damien: the yellow tongue that keys sheet into sheet. This is " +
      "the sheet that goes over JOISTS. Hurford's CD is the non-structural slab overlay; do not swap one for the " +
      "other. 5 thicknesses 9-25mm, all 2400 x 1200mm. The 25mm is a different SELEX line and prices well above " +
      "the rest per mm of thickness. " +
      "MOULDINGS are sold as whole 5.4m LENGTHS, not by the metre. Their figures came off inc-GST line totals " +
      "divided by 1.10, so a cent of difference inside one size band is a rounding artifact, while Bevel and " +
      "Half Splayed at 90mm and 138mm carry a real premium over their band.",
    fees: [
      {
        name: "Delivery",
        kind: "delivery",
        basis: "order",
        amount: 80,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$80 + GST per delivery to Terra's shop or the surrounding area, per Damien (26 Sep 2026). Auto-applies. Unlike Riverhill and Chameleon, Mitre 10 delivers themselves, so no Unified or Jocks booking is needed on a Mitre 10 order.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "artifloor",
    name: "ArtiFloor",
    // DELIBERATELY BLANK. The file is titled "CURRENT" and carries no effective
    // date anywhere in it. Guessing one would make a stale price look fresh.
    priceListSource: "ArtiFloor_Timberland_Runable_Price_List_CURRENT_(1)_905uan.xlsx",
    notes:
      "Luxury vinyl plank, one brand (Timberland) in two ranges: 4.5mm, 18 colours at $24.90/m2 on a " +
      "1524 x 228mm board, and 2.5mm, 6 colours at $15.90/m2 on a 1219 x 228mm board. One price per range — " +
      "every colour in a range costs the same. " +
      "THE WEAR LAYER IS 0.5mm ON BOTH. The $9.00/m2 (+56.6%) the 4.5mm carries buys a thicker core and a " +
      "longer board and nothing else. It is NOT the harder-wearing floor and must not be sold as one — the " +
      "surface the customer walks on is identical. " +
      "FOUR COLOUR NAMES EXIST IN BOTH RANGES (Coastal Blackbutt, Weathered Oak, Natural Blackbutt, White " +
      "Washed Oak) at a $9.00/m2 difference, so a quote line naming only the colour is ambiguous. Always " +
      "name the range. " +
      "ARTIFLOOR'S PRINTED CARTON AND PALLET m2 BOTH ROUND UP, and the pallet figure is the rounded carton " +
      "figure times the box count, so the error multiplies 60-fold: a pallet of 4.5mm is 166.79 m2, not the " +
      "167.4 m2 printed — 0.61 m2 short, nearly two boards on a job cut to the metre. Every m2 in the price " +
      "book is derived from the integer board count; the printed figures are kept only to check an ArtiFloor " +
      "invoice against ArtiFloor's own maths. " +
      "BOTH RANGES ARE OVER-LENGTH FOR FREIGHT: 1524mm, and the 2.5mm at 1219mm clears 1200mm by 19mm. Jocks " +
      "charges more above 1200mm where Unified does not, so on a Jocks booking both ranges attract it — the " +
      "2.5mm by a margin thinner than the board itself. " +
      "STILL OPEN: how these planks are installed (glue-down, loose lay or click — the list does not say, and " +
      "it decides whether adhesive has to be quoted alongside), whether ArtiFloor deliver and what freight " +
      "costs to Nerang, what date this pricing took effect, whether ArtiFloor supply trims, stair nosings or " +
      "adhesive, and what the AT1xx / AT2xx / AT3xx code blocks mean inside the 4.5mm range.",
    fees: [
      {
        name: "Picking & packing",
        kind: "handling",
        basis: "order",
        amount: 40,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$40 + GST per order. ArtiFloor print it on both of the price sheets supplied, so it applies to every order regardless of size — it is not a small-order penalty.",
        sortOrder: 10,
      },
      {
        name: "Freight",
        kind: "delivery",
        basis: "order",
        amount: null,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "NOT CONFIRMED. The list publishes picking & packing and nothing else — no delivery rate, no pickup address, no free-freight threshold. Ask ArtiFloor whether they deliver to Nerang and what it costs, then set the amount and turn auto-apply on. Until then a Jocks or Unified booking may be needed, and both ranges are over the 1200mm board length Jocks charges extra for.",
        sortOrder: 20,
      },
    ],
  },
  {
    code: "victoriacarpets",
    name: "Victoria Carpets",
    fuelSurchargeActive: false,
    // 1 Oct 2026, printed on every one of the 91 rows. FUTURE-DATED — the file
    // was supplied in September 2026, so this is the supplier's NEXT price
    // book. What they charge before 1 Oct is not in the file at all.
    priceListEffectiveFrom: "2026-10-01",
    priceListSource: "Victoria_Carpets_Oct_2026_Colours_and_Charges_ONLY_rRYK1a.xlsx",
    notes:
      "11 broadloom carpet ranges, 91 colours, priced per LINEAL METRE ex GST. One price per range — every colour in a range is the same money. $96.40/lm (TORENCO) to $183.40/lm (MACARTHUR), a 1.9x spread. " +
      "PRICES START 1 OCT 2026 AND THE LIST CARRIES NO OTHER DATE: quote October work off them, but do not check a September invoice against them — the current rates were not supplied. " +
      "NO PART-ROLL PREMIUM. The list has two separate price columns, 'Roll Price' and 'Cut Length Price', holding the SAME number on all 91 rows, so a cut length costs the same per metre as a full roll — unlike Belgotex broadloom or Polyflor sheet vinyl. Worth confirming once with Victoria Carpets that this is deliberate and not the cut column having been copied off the roll column; the quoting consequence is identical either way until they say otherwise. " +
      "BALING IS PER 40 lm STARTED, NOT PER ORDER — $35 per every 40 lineal metres 'and part thereof', so 40.0 lm is $35 and 40.1 lm is $70. The app cannot compute that basis yet (see the fee row) so it does not auto-apply. " +
      "ICONIC (2833, 8 colours) IS NOT ON VICTORIA CARPETS' OWN PRODUCTS INDEX — its colours come off a hosted specification sheet. Priced, so quotable, but ring before promising it. The other 10 ranges are on the live site. " +
      "ROLL WIDTH IS NOT PUBLISHED on any of the 91 lines, so lm cannot be converted to m2 for this supplier at all — that is the single biggest gap and the first thing to ask for. Also unstated: minimum order quantity, roll length, fibre, face weight, backing, whether Victoria Carpets deliver to the Gold Coast and what freight costs.",
    fees: [
      {
        name: "Baling",
        kind: "baling",
        basis: "order",
        amount: 35,
        amountIncludesGst: false,
        // DELIBERATELY NOT AUTO-APPLIED, and the basis here is a stand-in.
        // Victoria Carpets charge per 40 lm STARTED — ceil(lm / 40) x $35 — and
        // the fee engine's bases (order / shipment / pallet / roll / week /
        // percent_of_order) cannot express that; none of them multiplies by a
        // lineal-metre quantity. Auto-applying this on the `order` basis would
        // put a flat $35 on every quote, which is RIGHT up to 40 lm and wrong
        // by $35 for every 40 lm after that — a 120 lm job owes $105. A visibly
        // missing fee the office adds with the right multiple beats a quietly
        // wrong one, which is how Chameleon's unconfirmed $50 is handled too.
        autoApply: false,
        condition:
          "$35 + GST per every 40 lineal metres AND PART THEREOF — i.e. ceil(total lm / 40) x $35. 40.0 lm = $35, 40.1 lm = $70, 80.0 lm = $70, 80.1 lm = $105, 120 lm = $105. " +
          "DOES NOT AUTO-APPLY because the app has no per-40-lm fee basis, and the $35 stored here is ONE block only — add it by hand at the right multiple, or the quote is short $35 for every 40 lm past the first. " +
          "Watch the boundary: going 0.1 lm over a 40 lm block buys $9.64 of TORENCO and triggers a whole extra $35, so rounding a measure up 'to be safe' is not free on this supplier.",
        sortOrder: 10,
      },
      {
        name: "Freight",
        kind: "delivery",
        basis: "order",
        amount: null,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "NOT CONFIRMED. Baling is the only charge the supplied file publishes — no delivery rate, no pickup address, no free-freight threshold, and no stated origin. Ask Victoria Carpets whether they deliver to the Gold Coast and what it costs, then set the amount and turn auto-apply on.",
        sortOrder: 20,
      },
    ],
  },
  {
    code: "nfd",
    name: "NFD",
    // Every row of all three sheets says "NFD". "Arclan" appears only in the
    // FILENAME — there is an active Australian company ARCLAN PTY LTD, and NFD
    // trade as National Flooring Distributors out of Ormeau, so Arclan is most
    // likely the invoicing entity. NOT CONFIRMED, and it matters for matching
    // an invoice to this supplier: ask NFD whose name is on the bill.
    //
    // shipsFrom is NOT off the price list — the file states no origin. It is
    // NFD's own published warehouse address (Ormeau, QLD), which happens to be
    // ~25 min from the Gold Coast. Worth confirming that orders actually ship
    // from there before it is used for a freight decision.
    shipsFrom: "Ormeau, QLD",
    fuelSurchargeActive: false,
    // 12 Aug 2026, printed on all 203 product rows, all 16 accessory rows and
    // both charges. The only date in the file.
    priceListEffectiveFrom: "2026-08-12",
    priceListSource: "NFD_Arclan_Aug_2026_All_Colours_vcwo7z.xlsx",
    notes:
      "203 colour lines across 28 ranges and 5 categories — 102 vinyl plank, 28 hybrid, 28 laminate, 24 engineered timber, 21 carpet tile — priced per m2 ex GST, plus 13 trims and 3 underlays. One price per range: colour never moves the rate. $12.90/m2 (CALLOWAY vinyl) to $77.00/m2 (DAINTREE XL timber). Price list dated 12 Aug 2026. " +
      "NO PALLET DISCOUNT. The list has two separate price columns, 'Pallet/Roll Price' and 'Single/Cut Price', holding the SAME number on all 203 product rows — so on this supplier BUYING ONE BOX COSTS THE SAME PER m2 AS BUYING A FULL PALLET. Nothing is gained by rounding an order up to a pallet and nothing is lost by ordering three boxes. Worth confirming once with NFD that they genuinely have no pallet rate rather than the single column having been copied off the pallet column; the quoting consequence is identical either way until they say otherwise. " +
      "BIGGEST GAP BY A DISTANCE: THE FILE STATES NO SIZES AT ALL. No thickness, no wear layer, no board or tile dimensions, no boards per box, no AC rating — on none of the 203 rows. Every other vinyl/hybrid/laminate supplier in this book (ArtiFloor, Airlay, Polyflor, Sunstar, Chameleon) publishes at least some of it. Two consequences: a customer asking 'how thick is it' cannot be answered from the system, and because there is no integer board count, NFD's printed m2/box is the ONLY pack figure there is and has to be trusted for ordering maths — it cannot be cross-checked the way Sunstar's and Airlay's rounded m2/pack figures were. The only exceptions are LUXE GRAIN 12MM and LUXE GRAIN 8MM, which print thickness in the range name. " +
      "A COLOUR NAME DOES NOT IDENTIFY AN NFD PRODUCT. 28 colour names are used in more than one range at different prices — 'Spotted Gum' is REACTION at $17.90, DAINTREE - S/G at $69 and DAINTREE XL - S/G at $77, a 330% spread. Never order or quote off an NFD colour name without its range. " +
      "DAINTREE IS SIX SINGLE-COLOUR RANGES ON THE SHEET, not two ranges of three: 'DAINTREE - B/B', '- S/G', '- T/O' and the same three for DAINTREE XL, where the suffix IS the colour. Kept as NFD write them. Those 6 lines are also the ONLY rows in the file with no boxes/pallet figure, so a Daintree order cannot be turned into a pallet count — unpublished, not zero. " +
      "PACKING & ADMIN IS $75 FLAT PER ORDER, so it hits small orders brutally: on 10 m2 of CALLOWAY it is 58% on top of the goods, on 300 m2 it is 1.9%. Consolidating NFD orders is worth real money. " +
      "RANGES THAT LOOK LIKE ONE PRODUCT TWICE, and only one of them is explained: EVOLVE vs EVOLVE PLUS (same 4 colour names, same product URL on NFD's own site, $18 vs $23/m2 — nothing states what PLUS adds); DAINTREE vs DAINTREE XL (same 3 timbers, $69 vs $77 — 'XL' implies a bigger board but no dimension is given); LUXE GRAIN 8MM vs 12MM (same 10 decors, thickness is the difference and it is named); BESPOKE vs TRANQUILITY (all 10 BESPOKE colour names sit inside TRANQUILITY's 22 — a hybrid at $32.90 and an LVT at $44.90 sharing one decor set, which is a genuine 'same look, cheaper build' pair to sell if NFD confirm the decors match). " +
      "PERFORMANCE PLUS UNDERLAY IS THE ONE LINE IN THE FILE WHERE THE TWO PRICE COLUMNS DIFFER — $12 bulk against $16 single, a 33% uplift. Its unit is not printed either ($12 for a roll would be absurd next to $40 for CLASSICMAX foam, so it reads as per-m2), so it is seeded as price-on-application with both numbers recorded. " +
      "NFD WILL MAKE A STAIR NOSING FOR A FLOOR BOUGHT SOMEWHERE ELSE: 'NON NFD NOSING' in hybrid and LVT at $55 against $45 for their own — a $10 penalty for mixing suppliers. There is no non-NFD nosing for laminate or timber at all. " +
      "RETURNS ARE EXPENSIVE: 25% of the value of returned goods as a handling and re-stocking fee. Do not over-order NFD to be safe. " +
      "ALSO UNSTATED: freight to the Gold Coast (they ship from Ormeau, which is 25 minutes away, so pickup may well be the answer — ask), minimum order quantity, lead times, underlay roll width and coverage, and whether the trims have a bulk rate.",
    fees: [
      {
        name: "Packing & Admin Fee",
        kind: "handling",
        basis: "order",
        amount: 75,
        amountIncludesGst: false,
        // Unconditional and per order, exactly as the fee engine's `order`
        // basis computes it — so this one is safe to auto-apply.
        autoApply: true,
        condition:
          "$75 + GST on every NFD order, flat, regardless of size — stated as 'Per order' on their charges sheet with no threshold and no exemption. " +
          "It is a FLAT fee, so it punishes small orders: on 10 m2 of CALLOWAY ($12.90/m2) the $75 is 58% on top of the goods, on 40 m2 it is 15%, on 300 m2 it is 1.9%. Two small NFD orders in a week cost $150 of packing; one combined order costs $75.",
        sortOrder: 10,
      },
      {
        name: "Returns Handling & Re-Stocking Fee",
        kind: "handling",
        basis: "order",
        // NO AMOUNT ON PURPOSE, and the 25% is written out instead of stored.
        // This is a percentage of goods sent BACK, charged after the fact.
        // `percent_of_order` means percent of the order being PLACED, and
        // `quoteOrderCost` has no concept of a return, so there is no basis
        // that computes this. Storing 25 against percent_of_order would leave
        // the app one careless auto-apply toggle away from adding 25% to every
        // NFD quote — an invisible catastrophe. Same call as Chameleon's
        // unconfirmed $50 and Victoria Carpets' per-40-lm baling: a visibly
        // missing fee the office applies deliberately beats a quietly wrong one.
        amount: null,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "25% OF THE VALUE OF RETURNED GOODS, ex GST — charged when stock goes BACK to NFD, not when an order is placed. " +
          "DELIBERATELY HAS NO AMOUNT AND NEVER AUTO-APPLIES: the app's fee bases (order / shipment / pallet / roll / week / percent_of_order) all compute against an order being placed, and none of them can express a percentage of a later return. Work it out by hand on the credit, not here. " +
          "What it means for quoting: over-ordering NFD costs a quarter of whatever comes back. On 20 m2 of spare TRANQUILITY ($44.90/m2 = $898) the re-stocking fee is $224.50. Measure tight and order tight on this supplier.",
        sortOrder: 20,
      },
      {
        name: "Freight",
        kind: "delivery",
        basis: "order",
        amount: null,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "NOT CONFIRMED. Packing/admin and returns are the only charges the file publishes — no delivery rate, no free-freight threshold. NFD warehouse at Ormeau is about 25 minutes from the Gold Coast, so ask whether they deliver, what it costs, and whether pickup is practical before setting an amount and turning auto-apply on.",
        sortOrder: 30,
      },
    ],
  },
  {
    code: "eccarpets",
    name: "EC Carpets",
    // NOT off the price list — the file states no origin. EC Carpets are an
    // Australian manufacturer (since 1963) whose plant and head office are at
    // 3 Meyer Road, Lonsdale SA, with a second site at Melrose Park NSW. So
    // stock most likely comes from ADELAIDE, which is ~2,000 km from the Gold
    // Coast and is the same state Terramater ship from. Confirm which site
    // actually services Queensland before promising a customer a date.
    shipsFrom: "Lonsdale, SA (manufacturer)",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-09-22",
    priceListSource: "EC_Carpets_Terra_Flooring_2026_All_Colours_CpHpoU.xlsx",
    notes:
      "236 broadloom colours across 27 ranges, all carpet, all priced PER LINEAL METRE ex GST. Four fibres: Solution Dyed Nylon (14 ranges, 133 colours, $77.90–$139.90/lm), Pure Wool (6 ranges, 50 colours, $144.90–$249.90/lm), Polypropylene (5 ranges, 37 colours, $55.90–$71.90/lm), Polyester (2 ranges, 16 colours, $97.90–$106.90/lm). One price per range — colour never moves the rate. Price list dated 22 Sep 2026, the only date in the file and current (unlike Victoria Carpets, whose list is future-dated). Australian-made. " +
      "THE 25 LINEAL METRE BREAK IS A FLAT $8.00/lm OFF, AND IT IS WORTH MOST ON THE CHEAPEST CARPET. 10 of the 27 ranges publish an 'Over 25m' rate, and on every single one of them the discount is exactly eight dollars a metre — not a percentage. So it is 14.1% off Summit Point ($56.90 polypropylene) and only 4.3% off Dawson Falls ($186.90 wool). That inverts the usual instinct: chasing the 25 m threshold pays best at the BUDGET end of the book. Seeded the way the app already models roll-vs-cut — rollM2 = 25 lm, costPrice = the over-25m rate, cutCostPrice = the standard rate — so quoting picks the right one off the quantity and will also flag when buying the full 25 lm beats the shorter run actually wanted (under 21.49 lm of Summit Point, 25 lm is literally cheaper than what you asked for). " +
      "THE OTHER 17 RANGES PUBLISH NO BREAK, AND THE BLANKS TRACK THE FIBRE: Polyester 2 of 2 ranges have it, Polypropylene 4 of 5, but Solution Dyed Nylon only 3 of 14 and Pure Wool only 1 of 6. That pattern reads as deliberate policy (volume money on cheap carpet, not on wool) rather than an unfilled column, so nothing was back-filled with an assumed $8 — those 17 quote at one rate until EC say otherwise. Ask, because if the break does apply to wool it is worth $200 on a 25 m Elmsford job. " +
      "BIGGEST GAP: NO ROLL WIDTH ANYWHERE IN THE FILE. Every row sells by the lineal metre and not one states how wide the roll is, so lm CANNOT be converted to m2 for any EC line — a floor measured in m2 cannot be costed off this list without ringing them. widthM is null on all 236 rows. NOT FROM EC, BUT STRONGLY INDICATED: independent retailer spec listings (Harvey Norman, Floormania, Goodwood, flooringpros) all state 3.66 m for Boucle, Orchard and Flinders Gorge, so 3.66 m is very likely the standard SDN roll. It is deliberately NOT seeded — a 4.0 m assumption on a 3.66 m roll under-orders a job by 9% — but it is the number to put to EC for confirmation, range by range, wool included. " +
      "COLOUR CODE 8104 IS TWO DIFFERENT PRODUCTS AT TWO DIFFERENT PRICES: Dolomites 'Madonna' at $106.90/lm and Sky Bridge 'Marlow' at $97.90/lm, both Polyester. 235 of the 236 codes are unique, so this one is a genuine trap — a code is what an order gets typed off, and ordering '8104' without naming the range is a coin flip on $9.00/lm. Both rows carry a warning. Unlike NFD, no colour NAME is reused anywhere in this book, so range + colour is always a safe way to order. " +
      "FREIGHT IS THE ONLY CHARGE AND IT IS SUSPICIOUSLY CHEAP FOR THE DISTANCE: $69.90 per invoice, flat, for goods that most likely come from Adelaide. Terramater charge a 2% fuel surcharge out of the same state. Worth confirming $69.90 really is all-in to the Gold Coast and not a handling fee with freight billed on top. Being flat and per-invoice it also punishes small orders: 25% on top of 5 lm of Montrosa, 0.3% on 100 lm of Elmsford — consolidate EC orders. " +
      "ALSO UNSTATED: roll width (above), minimum order quantity, lead times from SA, whether a part-roll cut carries any premium beyond losing the 25 m rate, underlay, and whether EC supply their own accessories at all — this file is broadloom and one freight charge, nothing else.",
    fees: [
      {
        name: "Freight & Handling",
        kind: "delivery",
        basis: "order",
        amount: 69.9,
        amountIncludesGst: false,
        // "Per invoice", unconditional, no threshold — which is exactly what
        // the `order` basis computes, so it is safe to auto-apply.
        autoApply: true,
        condition:
          "$69.90 + GST per invoice, stated as 'Per invoice' on EC's charges sheet with no threshold and no free-freight level. The only charge the file publishes. " +
          "FLAT, so it bites small orders: against the cheapest range in the book (Montrosa, $55.90/lm) it is 25% on top of 5 lm and 12.5% on 10 lm; against the dearest (Elmsford, $249.90/lm) it is 0.3% on 100 lm. Per INVOICE, not per delivery — so two EC orders in a week cost $139.80 and one combined order costs $69.90. " +
          "CONFIRM IT IS ALL-IN: EC manufacture in Lonsdale SA, and $69.90 flat to the Gold Coast is cheap for 2,000 km. If it turns out to be handling with freight on top, this amount is wrong and every EC quote is under.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "bigpanda",
    name: "Big Panda Flooring",
    // Off their notes sheet, which states the warehouse address outright.
    // Acacia Ridge is Brisbane's south side, ~45 min up the M1 from the Gold
    // Coast — close enough that pickup is a real option, which is very likely
    // why they get away with not delivering at all.
    shipsFrom: "Acacia Ridge, QLD (pickup or Terra's own carrier — they do not deliver)",
    // Same flag as Chaparral, different reason: Chaparral hand off to an
    // on-forwarder, Big Panda simply do not deliver. Their notes sheet states
    // it outright, so this is a confirmed no, not a gap.
    deliversDirect: false,
    freightMethod: "Pickup from Acacia Ridge, or Terra's own carrier",
    freightNote:
      "Big Panda do not deliver, stated outright on their notes sheet: \"Supplier does not deliver. Terra Flooring must arrange its own transport / pickup.\" Acacia Ridge is about 45 min up the M1, so pickup is a real option. There is no supplier delivery charge to exclude because there is no delivery — freight on a Big Panda order belongs to whichever carrier or ute run is used, so it goes in the Transport field on the order cost.",
    fuelSurchargeActive: false,
    // WEAKEST-SOURCED DATE IN THE BOOK. This workbook has NO date column — not
    // on the products sheet, not on the accessories sheet, not in the notes.
    // Feb 2025 comes from the FILENAME, which is Damien's own naming and not
    // the supplier's print. Terramater's 1 Apr 2025 was printed on the list and
    // NFD's 12 Aug 2026 was on all 219 rows; this one is an inference.
    priceListEffectiveFrom: "2025-02-01",
    priceListSource: "Big_Panda_Flooring_Feb_2025_Terra_otVGLw.xlsx",
    notes:
      "38 colour lines across 5 ranges and 2 categories — 25 SPC hybrid (Titan Guard 6.5mm / 8.0mm / 10.5mm) and 13 engineered oak (Luminous Oak 15/2mm, Modern Engineered Timber 14/3mm) — priced per m2 ex GST, plus 5 trims and one underlay. The smallest and narrowest flooring book in the system: no vinyl, no laminate, no carpet, no carpet tile. $18.50/m2 (Titan Guard 6.5mm) to $62.00/m2 (Modern Engineered, 2200x220 board). " +
      "SECOND-CHEAPEST HYBRID IN THE BOOK at $18.50/m2, behind Sunstar Classic Hybrid at $17.50 — and both are cheap for the same reason, a thin board. Read the pad note below before comparing that $18.50 to anything. " +
      "TITAN GUARD 8.0mm LOOKS LIKE THE SAME BOARD AS AIRLAY OAKWOOD, AND AIRLAY PUBLISH THE SPEC BIG PANDA DO NOT. Airlay Oakwood: 1500 x 228mm, 8.0mm, '6.5 + 1.5mm build', IXPE underlay, 0.5mm wear layer, $26.50/m2, 5 boards/1.71 m2 per box. Big Panda Titan Guard 8.0mm: 1500 x 228mm, 6.5+1.5mm, wear layer unpublished, $25.50/m2, 6 boards/2.052 m2 per box. Identical board and identical build split, $1/m2 apart. Two things follow: Airlay's 0.5mm is the best available PROXY for Big Panda's unpublished wear layer (a proxy, not a fact, and not to be quoted as one), and Airlay's published '6.5 + 1.5mm build' with a SEPARATE 0.5mm wear layer is independent proof that the '+1.5' is underlay and not wear. Worth asking Big Panda straight out whether it is the same factory product. " +
      "THE PRICE LIST DATE IS AN INFERENCE, NOT A FACT. There is no date anywhere in the file; Feb 2025 is off the filename. Whatever the real date, it is the oldest list in the book — 19 months at Sep 2026, older than Terramater's Apr 2025. Re-confirm every rate before a large order and get a dated list. " +
      "THE RANGE DOES NOT DETERMINE THE PRICE ON ONE RANGE. 'Modern Engineered Timber / Oak 14/3mm' carries TWO rates split by BOARD SIZE: 1900x190 at $59.00 (Natural Oak, White Sand, Dark Oak, Light Oak) and 2200x220 at $62.00 (Country Oak, Cream Oak). Same range name, same 14/3mm build, bigger board, $3/m2 more. So 'Modern Engineered Timber, 40 m2' is not a quotable sentence without the colour — it is a $120 difference on that job. Big Panda is the only supplier in the book where a range splits its price on size. The other four ranges are one rate for every colour. " +
      "THE NAMED SPC THICKNESS INCLUDES AN ATTACHED PAD, AND THIS IS THE EASIEST THING IN THE BOOK TO GET WRONG. Titan Guard 6.5mm is a 5mm board with 1.5mm of IXPE stuck to the back. 8.0mm is a 6.5mm board + 1.5mm. 10.5mm is a 9mm board + 1.5mm. So a competitor quoting '6.5mm SPC' with no attached pad is selling 6.5mm of actual board, and the honest Big Panda match for it is the 8.0mm at $25.50, not the 6.5mm at $18.50. Sell the pad as the feature it is (no separate underlay to buy or lay on SPC) but never let the mm number be compared straight across. " +
      "NO WEAR LAYER IS PUBLISHED ON A SINGLE SPC ROW. The '+1.5mm' is UNDERLAY, not wear layer — calling it wear layer to a customer would be a material misrepresentation. Wear layer (0.3mm domestic vs 0.5mm light commercial) is the spec a commercial buyer asks for by name and it is simply absent, as is any AC or commercial rating. The 'Surface / Grade' column gives embossing instead ('Random EIR' on the 6.5mm, 'Wood texture' on the 8.0 and 10.5mm) which describes a look, not durability. Cannot answer 'is this rated for a shop' from this file. " +
      "BOARDS PER BOX ARE RECOVERABLE, WHICH IS UNUSUAL HERE. No boards-per-box column, but every printed m2/box divides by the board area into a whole number of boards (6 boards on 1500x228, 3 on 1800x230, 6 on Luminous, 8 on Modern 1900x190, 6 on Modern 2200x220), so the integer count is derived rather than trusted. Only the 2200x220 drifts: 6 boards is 2.904 m2 against a printed 2.900, so those 2 rows keep the printed figure for invoice cross-checks and use the derived one for ordering. " +
      "THE 10.5mm BOX IS HALF THE SIZE OF THE OTHERS — 1.242 m2 against 2.052. A 100 m2 job is 49 boxes of 6.5mm but 81 boxes of 10.5mm: 65% more boxes to load, stack and count for the same floor. With no boxes-per-pallet and no weights published, that box count is the only handling signal in the file. " +
      "EVERY BOARD IS OVER 1200mm, SO EVERY BIG PANDA ORDER IS A UNIFIED ORDER. Shortest board in the file is 1500mm and the longest is 2200mm. Jocks charge more over 1200mm and Unified do not, so the carrier choice is already made on board length alone — no need to work it per order. What CANNOT be worked out is the freight price: no boxes per pallet, no box weight, no pallet weight anywhere in the file. " +
      "NOTHING IN THE ACCESSORIES SHEET FITS THE ENGINEERED TIMBER. All 6 accessories are SPC or laminate items. Both oaks — the $48 and $59/$62 ranges, the expensive half of the book — have no scotia, no trim, no reducer and no stair nosing from this supplier, so a Luminous Oak job has to buy its trims elsewhere. " +
      "THE SCOTIA FITS ONE THICKNESS ONLY: 'Scotia PVC/WPC, 6.5mm SPC ONLY' at $4.80/length. Quoting it on an 8.0mm or 10.5mm job would be wrong, so it is the one accessory in this book carrying a real per-range restriction. The L Angle Trim gives two lengths at one price — 2400mm for 6.5mm and 10.5mm SPC, 2700mm for 8mm only — so $7.70 buys 300mm more trim on an 8mm job. " +
      "THE STAIR NOSING SAYS 'All Laminate/SPC' AND BIG PANDA SELL NO LAMINATE. Either it is shared stock off a laminate range they no longer list, or the products sheet is incomplete and there is laminate to be had. Worth one question. " +
      "MDF SCOTIA IS DELIBERATELY ABSENT — Damien excluded it because Terra does not sell it. Recorded so no one 'fixes' the gap later. " +
      "THE 2mm UNDERLAY IS $40 FOR A 50 m2 ROLL = $0.80/m2, and what it is FOR is unstated: all 25 SPC lines already have 1.5mm of pad attached and do not need it, so it reads as being for the engineered oak, but that is a reading. " +
      "A COLOUR NAME DOES NOT ALWAYS IDENTIFY A BIG PANDA PRODUCT: 'Natural Oak' is Titan Guard 8.0mm SPC at $25.50 and Modern Engineered oak at $59.00 — the same two words for a plastic plank and a real timber floor, 2.3x apart. Only the one collision, but it is a bad one to get wrong on a quote. " +
      "ALSO UNSTATED: minimum order quantity, lead times, whether stock is held at Acacia Ridge or brought in, warranty (domestic and commercial), slip rating, whether the 6.5mm and 8.0mm share the 1500x228 board tooling and therefore the same decor set, and any trade or volume rate.",
    // ZERO FEES, AND THAT IS A CONFIRMED ZERO, NOT A GAP. Their notes sheet
    // states both halves outright: "Supplier does not deliver. Terra Flooring
    // must arrange its own transport / pickup." and "No baling, packing or
    // dispatch fee." So there is no delivery fee to model because they do not
    // deliver, and no handling fee because they do not charge one.
    //
    // Worth seeing next to the others: on a 40 m2 order Terramater adds $30
    // baling + $100 delivery + 2% fuel and NFD adds $75 flat packing, while
    // Big Panda adds nothing and Terra does the driving. Freight is a real
    // cost, it just is not a SUPPLIER cost here — it belongs to whichever
    // carrier or ute run is used, which is why nothing is invented for it.
    fees: [],
  },
  {
    code: "chaparral",
    name: "Chaparral Carpets",
    // Not stated in the workbook. Left blank rather than guessed — the only
    // freight fact on file is how it REACHES Terra, which is below.
    shipsFrom: "",
    // THE REASON `deliversDirect` EXISTS. Chaparral publish a delivery charge
    // and Terra never pays it: the stock goes to Jocks Transport as
    // on-forwarder and Terra arranges and pays that leg itself. Their charge
    // on a Terra cost sheet would bill the same freight twice.
    deliversDirect: false,
    freightMethod: "Jocks Transport / on-forwarder",
    freightNote:
      "Chaparral do NOT deliver direct to Terra. Orders are on-forwarded through Jocks Transport and Terra arranges and pays that leg separately, so it is a Terra transport cost and not a Chaparral charge. " +
      "Chaparral's own published delivery charge ($95 under 12 lm, per Damien — NOT printed in the price workbook) must never auto-apply: it is recorded as an unticked fee for reference only. Put the real Jocks cost in the Transport field on the order cost, where it stays separately identifiable from the supplier's own charges. " +
      "Source: the workbook's Supplier Rules sheet, verbatim — \"Do not apply Chaparral direct delivery charge. Terra uses Jocks Transport / on-forwarder; transport cost handled separately.\"",
    fuelSurchargeActive: false,
    // Printed on all 22 colour rows of the workbook, not inferred: "1 June 2026".
    // The NEWEST list in the book — 4 months old at Sep 2026, against Big
    // Panda's inferred Feb 2025.
    priceListEffectiveFrom: "2026-06-01",
    priceListSource: "Chaparral_Carpets_Runable_Current_Ranges_2026_No_Natural_Choices_2rId6l.xlsx",
    notes:
      "22 broadloom carpet colours across 3 ranges — Apartment 2 (9 colours), Kingston (7), Outback (6) — priced per BROADLOOM LINEAL METRE ex GST, not per m2. Every row carries two rates: a Cut Length price and a cheaper Roll price. $58.00/lm (Apartment 2 roll) to $138.00/lm (Outback cut). " +
      "THE PRICE DEPENDS ON THE ORDER SIZE, NOT THE PRODUCT. Under 20.00 broadloom lineal metres bills at the Cut Length price; 20.00 lm and over bills at the Roll price. The two are never averaged and the break is chosen off the order quantity, per the workbook's Supplier Rules sheet. The gap is $10.00/lm on all three ranges, so 19 lm of Apartment 2 costs $1,292.00 and 20 lm costs $1,160.00 — ordering ONE MORE METRE IS $132.00 CHEAPER. Same trap on Kingston ($89/$79) and Outback ($138/$128). Worth checking on any Chaparral quote that lands between about 17 and 20 lm. " +
      "TWO CHARGES RUN AT ONCE ON DIFFERENT BASES, which is why the single fuel-surcharge percentage was replaced: $2.00 per LINEAL METRE fuel and $20.00 PER ORDER baling, both ex GST, both live. The fuel surcharge applies AFTER the cut/roll rate is chosen, so 15 lm of Apartment 2 = 15 x $68.00 + 15 x $2.00 = $1,050.00 and 25 lm = 25 x $58.00 + 25 x $2.00 = $1,500.00, then $20.00 baling once on top of either. The surcharge is temporary and dated from 1 Jun 2026 with no end date, so it is NOT baked into any costPrice — switch it off in one place when Chaparral drop it. " +
      "BALING IS PER ORDER, NOT PER ROLL, PER DAMIEN, AND THAT OVERRIDES THE WORKBOOK. The Supplier Rules sheet and all 22 colour rows word it 'per roll' and it was originally modelled that way. It is $20.00 flat however many rolls or metres are on the order. This is the opposite basis to Victoria Carpets, whose baling really is per 40 lm started, so do not copy one supplier's treatment onto the other. " +
      "TWO RANGES DAMIEN NAMED ARE DELIBERATELY ABSENT: Natural Direction and Brompton. The workbook's own Supplier Rules sheet says to keep only ranges currently shown on Chaparral's website and that both were removed, and neither has a price row anywhere in the file. Damien's message quoted figures for them ($88/$78 and $118/$108) but nothing in the source supports those, so they are not seeded — the same call made on Big Panda's MDF Scotia. If either is still orderable, ask Chaparral for a current sheet and they can be added in minutes. " +
      "THE OUTBACK SOURCE URL IS THE GENERIC RANGE PAGE (chaparral.com.au/carpet-range/), not a product page like Apartment 2's and Kingston's. So Outback's 6 colours and $138/$128 rates are the least directly verifiable rows in the file even though they are the dearest. " +
      "ROLL WIDTH IS 3.60 m ON ALL 22 ROWS, AND IT DOES NOT COME FROM THE WORKBOOK. Damien confirmed it directly; the price file publishes no width anywhere. That single figure is the whole lm-to-m2 conversion, so it is what finally lets a Chaparral per-lm rate be compared against the per-m2 suppliers in the book: Apartment 2 works out at $18.89 cut / $16.11 roll per m2, Kingston $24.72 / $21.94, Outback $38.33 / $35.56, and one 20 lm roll covers 72.0 m2. Anyone re-checking these rates should treat 3.60 m as owner-supplied, not printed spec, and re-confirm it with Chaparral in writing. " +
      "NOTE 3.60 m IS NARROWER THAN THE TRADE-STANDARD 3.66 m, which matters because the error runs the wrong way. Assuming 3.66 m under-orders by 1.7% and assuming 4.00 m under-orders by 10%, so a width guessed off habit rather than off this figure short-measures the job. Worth putting to Chaparral to confirm whether 3.60 m is their actual milled width across all three ranges or a rounded one. " +
      "STILL UNSTATED AND WORTH ASKING: fibre and construction, pile weight, durability or commercial rating, stain and wear warranty, roll length, whether part-rolls are cut to order at all, lead time, minimum order, and any trade or volume rate. Roll length no longer blocks anything on the costing side now baling is per order rather than per roll, it is just still unknown.",
    fees: [
      {
        name: "Fuel Surcharge",
        kind: "fuel",
        basis: "lm",
        amount: 2,
        amountIncludesGst: false,
        // Every colour row carries it and the rules sheet calls it active, so
        // it is automatic. Per LINEAL METRE, so it scales with the order and
        // no percentage can express it.
        autoApply: true,
        effectiveFrom: "2026-06-01",
        // NULL = until further notice. That is the supplier declining to name
        // an end date, not a claim that it is permanent.
        effectiveUntil: null,
        condition:
          "$2.00 per broadloom lineal metre + GST on every order, charged ON TOP of whichever rate the cut/roll break picked. Stated on all 22 colour rows and again on the Supplier Rules sheet as 'temporary, active until further notice'. " +
          "It is 3.4% of Apartment 2's roll rate but only 1.4% of Outback's, so it hurts the cheap range most.",
        notes:
          "TEMPORARY BY THE SUPPLIER'S OWN WORDING, which is exactly why it lives here and not in the 22 product rows. Ask Chaparral on each order whether it still applies, and switch this one row off the day they drop it. No end date given.",
        sortOrder: 10,
      },
      {
        name: "Baling Charge",
        kind: "baling",
        // PER ORDER, NOT PER ROLL. Per Damien, and it overrides the workbook's
        // "per roll" wording, which is what this row used to be modelled on.
        basis: "order",
        amount: 20,
        amountIncludesGst: false,
        autoApply: true,
        effectiveFrom: "2026-06-01",
        effectiveUntil: null,
        condition:
          "$20.00 + GST ONCE PER ORDER, flat. Per Damien, and it overrides the workbook: the Supplier Rules sheet and every colour row word it as 'per roll', which this was originally modelled on. It is one charge no matter how many rolls or metres are on the order, so a 20 lm order and a 200 lm order both carry $20.00. Nothing needs to be entered for it and no roll count is required.",
        notes:
          "Unlike the fuel surcharge this is not flagged temporary. Being per order also removes what used to be the open question here: the workbook publishes no roll length, so a per-roll charge could never be counted accurately on a big order. Flat per order means there is nothing left to assume.",
        sortOrder: 20,
      },
      {
        name: "Chaparral direct delivery (NOT USED, reference only)",
        kind: "delivery",
        basis: "order",
        amount: 95,
        amountIncludesGst: false,
        // NEVER AUTOMATIC. Two guards, on purpose: autoApply is off so nothing
        // can bill it, and `deliversDirect: false` makes the charge engine
        // refuse it with a reason even if someone ticks it by hand.
        autoApply: false,
        effectiveFrom: "2026-06-01",
        effectiveUntil: null,
        condition:
          "DO NOT TICK. Chaparral's own published charge for orders under 12 lm. Terra never pays it — the stock is on-forwarded through Jocks Transport and Terra pays that carrier directly, so charging this too would bill the same freight twice. On file so the number is known, not so it can be used.",
        notes:
          "WEAKEST-SOURCED ROW ON THIS SUPPLIER. The $95 and the 12 lm threshold come from Damien's message, not from the workbook — the price file has no delivery charge in it at all, only the instruction not to apply one. The under-12-lm threshold is also not modelled here (basis is a flat order charge), which is harmless while it stays unticked but would be wrong if it were ever switched on.",
        sortOrder: 30,
      },
    ],
  },
  {
    code: "tarkett",
    name: "Tarkett",
    // Not stated. Tarkett is a global manufacturer and the quote says nothing
    // about which warehouse a Gold Coast order ships from, so it stays blank.
    shipsFrom: "",
    // UNKNOWN, NOT FALSE. Chaparral's `false` is a stated fact: they hand off
    // to Jocks. Tarkett's "Delivery to Terra shop" row exists on the source
    // and is simply unpriced, which reads as "they do deliver, nobody has
    // asked what it costs". Left at the default rather than asserting either
    // way, because `false` would suppress a delivery charge that may be real.
    freightMethod: "",
    freightNote:
      "DELIVERY TO THE TERRA SHOP IS UNPRICED. The source's Manual Charges sheet carries the row and leaves the amount blank, marked Active: No, noted 'Enter when known'. So there is no delivery fee row here and a Tarkett order cost is SHORT BY WHATEVER FREIGHT COSTS until someone rings them. Same for baling. Ask Tarkett for both, then add two fee rows.",
    // Superseded by the kind:"fuel" fee row below, but kept true and in step
    // with it so the supplier card does not say "no surcharge" while a live
    // 2.1% rule sits underneath.
    fuelSurchargeActive: true,
    fuelSurchargePct: 2.1,
    fuelSurchargeNote:
      "2.1% of the material price, temporary by Tarkett's wording, active now. Held as a percent_of_order fee rule so it can be switched off in one place.",
    priceListEffectiveFrom: "2025-06-09",
    priceListSource: "Tarkett custom pricing quote 1210062 (09/06/2025), owner-supplied workbook with colours and stock status from professionals.tarkett.com.au",
    notes:
      "180 commercial sheet vinyl colours across 8 ranges — iQ Granit (New) 50, Ruby 70 33, Primo Premium 30, iQ Eminent 26, Granit Safe.T 24, Safetred Universal PU 8, Wallgard 2mm 5, Safetred Universal Plus R12 4 — priced per m2 ex GST. $22.00/m2 (Ruby 70, Wallgard) to $34.50/m2 (Granit Safe.T). One price per range, every colour in a range shares it. All 2m wide, rolls 20 / 23 / 25m long, so 40 / 46 / 50 m2 a roll. " +
      "STOCK IS PER COLOUR AND IT IS THE BIGGEST THING ON THIS SUPPLIER. 110 of the 180 colours are held in Australian stock. The other 70 are IMPORT ONLY at 8-10 WEEKS from order. The split runs THROUGH the ranges, not between them: iQ Granit (New) has 21 stocked colours and 29 import-only ones at the identical $33.50/m2, Ruby 70 is 14 stocked against 19 import, Primo Premium 19 against 11, Granit Safe.T 17 against 7, iQ Eminent 22 against 4. Nothing in the price or the spec tells you which is which, so the flag is on every colour row and the 8-10 week wording goes in the product's availability note. " +
      "THE THREE SAFETRED AND WALLGARD RANGES ARE FULLY STOCKED, all 17 colours between them, so they are the safe pick on a job with a date on it. " +
      "8-10 WEEKS IS KEPT AS WEEKS EVERYWHERE, deliberately. It is what Tarkett said and it is what a customer gets told. The products carry leadTimeDays as the conservative 70-day end for date arithmetic only — never quote the day figure, quote the weeks. " +
      "2.1% FUEL SURCHARGE IS LIVE AND IS NOT IN ANY PRICE. Tarkett call it temporary, so it is a dated percent_of_order fee rule rather than 180 marked-up costPrice values. On iQ Granit (New) it is 70c/m2, taking $33.50 to $34.20 effective. " +
      "THE RESILOOP LEVY IS ALREADY IN THESE PRICES — 9c/m2, per the quote's own wording, for the relevant HO/HE/LVT/Hybrid products. DO NOT add it again as a fee. There is no Resiloop fee row here on purpose. " +
      "BALING AND DELIVERY TO THE TERRA SHOP ARE BOTH UNPRICED AND BOTH MISSING FROM THE ORDER COST. The source leaves both blank and marks them Active: No. No fee row is invented for either. A Tarkett order cost is therefore incomplete until Tarkett confirm the two figures — that is the top open question on this supplier. " +
      "WALLGARD 2mm IS WALL CLADDING, NOT FLOORING. Same quote, same 2m width, same $22.00/m2 as Ruby 70, but it goes up a wall. Its 5 colours are flagged so nobody specifies it as a floor. " +
      "45 OF THE 180 COLOURS HAVE NO SUPPLIER CODE — every Safetred colour and every Ruby 70 'Uno' colour. Their sku is blank because Tarkett publish none, not because it is missing. Quote them by range and colour name. " +
      "STOCK STATUS CAME FROM THE BLUE AUSTRALIAN-STOCK BADGE on Tarkett's own AU website, read off owner-supplied screenshots, not from the pricing quote. Badge means locally stocked, no badge means import. It is the softest-sourced fact on this supplier and it is the one that moves a delivery date, so re-check it with Tarkett before committing to a job date on any import colour. " +
      "PRICES ARE 15 MONTHS OLD as at Sep 2026 — quote 1210062 is dated 09/06/2025 and is the only date in the file. Worth asking for a refreshed quote. " +
      "STILL UNSTATED: baling, delivery, thickness, wear layer, slip rating beyond what the Safetred R12 name implies, acoustic rating, warranty, minimum order, and whether part-rolls are cut to order or only sold whole.",
    fees: [
      {
        name: "Fuel Surcharge",
        kind: "fuel",
        // THE FIRST PERCENT-BASED FEE IN THE BOOK. `percent_of_order` takes
        // `percent`, not `amount`, and the charge engine reads it as a
        // percentage of the ex-GST goods on the order.
        basis: "percent_of_order",
        percent: 2.1,
        amount: null,
        amountIncludesGst: false,
        // The source's Manual Charges sheet marks it Active: Yes.
        autoApply: true,
        // The quote's own date. Tarkett name no start date for the surcharge
        // itself, so the price list date is the earliest defensible one.
        effectiveFrom: "2025-06-09",
        // NULL = until further notice. Tarkett called it temporary and gave
        // no end date, which is not the same as permanent.
        effectiveUntil: null,
        condition:
          "2.1% + GST of the ex-GST material on the order, on top of the quoted m2 rate. Stated on all 180 colour rows of the source and again on the Manual Charges sheet as an active temporary surcharge. " +
          "Worth 70c/m2 on iQ Granit (New) at $33.50, 72c on Granit Safe.T at $34.50, 46c on Ruby 70 at $22.00. A 46 m2 roll of iQ Granit is $1,541.00 of goods and $1,573.36 once the surcharge lands.",
        notes:
          "TEMPORARY BY THE SUPPLIER'S OWN WORDING, which is why it lives here rather than baked into 180 costPrice values — switching it off is one row, re-importing the list is not. Ask Tarkett on each order whether it still applies. No end date given, and the quote it is attached to is dated 09/06/2025.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "mjs",
    name: "MJS Floorcoverings",
    // Not stated on the February 2026 list. MJS run several branches and the
    // list names none of them as the dispatch point, so it stays blank rather
    // than guessed off the forwarding rows.
    shipsFrom: "",
    // TRUE, AND CONFIRMED BY DAMIEN, NOT INFERRED. MJS truck it to the Terra
    // shop on a normal order and charge nothing for that leg. This is the
    // opposite of Chaparral, whose stock goes through Jocks and whose
    // published delivery charge must never be billed.
    deliversDirect: true,
    freightMethod: "MJS deliver direct to the Terra shop",
    freightNote:
      "NO FREIGHT CHARGE ON A NORMAL MJS ORDER. MJS deliver direct to the shop and charge nothing for it, per Damien. " +
      "The $85/order metro forwarding charge on the list is for an order FORWARDED ex another MJS location, which is not how Terra buy, so it is seeded UNTICKED for reference and must never auto-apply. " +
      "COUNTRY FORWARDING IS NOT MODELLED AT ALL, by Damien's call. The list prices it at $85 base plus $0.30/kg on sheet and turf rolls or $0.10/kg on pallets, and the per-kg leg needs a product weight the February 2026 list does not publish anywhere. The figures are recorded in the notes so they are not lost if a country job ever comes up.",
    // No fuel surcharge on this supplier at all. Unlike Tarkett and Chaparral,
    // the February 2026 list carries no fuel row anywhere.
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-02-01",
    priceListSource: "MJS Floorcoverings February 2026 price list (issued 1 February 2026), owner-supplied workbook with colours from MJS's current website",
    notes:
      "104 lines across 31 ranges — 20 commercial sheet vinyl, 44 luxury vinyl plank, 18 residential sheet, 6 carpet tile, 6 needle punch, 7 synthetic turf, 3 weld rods. Sheet, plank, tile and needle punch are per m2 ex GST; turf and weld rod are per LINEAL METRE. " +
      "THREE RATES ON ONE LINE, AND THAT IS WHAT MAKES THIS SUPPLIER DIFFERENT FROM EVERY OTHER ONE IN THE BOOK. Somplan 100 is $20.56/m2 cut, $17.50/m2 a roll, and $16.90/m2 once the ORDER passes 300 m2. The cut/roll pair answers 'did MJS have to cut this'. The third rate answers 'how big is the whole order'. Two different questions, both moving the rate on the same product, and a 400 m2 order answers both at once — which is why the third rate has its own columns (volumeCostPrice / volumeQty) rather than being squeezed into the cut/roll pair. " +
      "8 RANGES CARRY ALL THREE RATES: Somplan 100, 350, 500 and 650, Somwall 1.3mm and 2.0mm, Somplan Safe.T, Xtreme Woods. All 8 are commercial sheet. " +
      "7 MORE CARRY THE OVER-300 RATE WITHOUT A CUT RATE, because they are carton goods and a carton is not cut: the four Tru Plank LVP ranges, Tru Plank Matilda XL, and both True Dimensions carpet tile ranges. " +
      "THE 17.5% CUT SURCHARGE IS ALREADY INSIDE THE PRINTED CUT PRICE AND THERE IS DELIBERATELY NO FEE ROW FOR IT. The Charges & Rules sheet lists it as though it were separate. It is not: Damien confirmed the Cut Price column IS the roll rate with the 17.5% applied, and the extract asserts $17.50 x 1.175 = $20.56 on every commercial sheet row rather than taking that on trust. Adding it as a fee would charge 17.5% on top of a price that already carries it. " +
      "BALING IS REAL AND IS THE ONE THING THAT CAN BE MISSED ON A CUT ORDER: $20 per cut length on commercial vinyl, $50 per half roll on residential sheet, $50 per cut length on Tru Turf. All three are seeded UNTICKED, because whether one bites depends on whether the order is a cut or a whole roll, and the charge engine cannot see that yet. The office ticks the right one. None of the three printed units exists as a fee basis, so the nearest honest basis is used and MJS's own wording is kept in the condition text. " +
      "4 SAFETRED ROWS FROM THE SOURCE ARE NOT SEEDED, ON PURPOSE. Safetred Universal R11 and Universal Plus R12, two colours each. Tarkett sell the same two ranges at $34.00/m2 flat plus 2.1% fuel ($34.71 effective), while MJS want $35.50 and $44.00 a roll and only reach $34.00 and $42.00 past 300 m2 — dearer on every normal order size and never cheaper. Two prices for one product in the book is how a quote picks the dearer one. Reverse it if MJS ever undercut. The Tarkett rows are untouched. " +
      "8 RANGES ARE SEEDED WITH A BLANK COLOUR AND THAT IS CORRECT: Somplan 100, 500 and 650, both Somwalls, Somplan Safe.T, Tru Plank Elite and Elite Tile. MJS's website does not reliably expose a colour list for them and the source's own rule is to never invent one. Quote them by range and code. A blank colour here means 'MJS publish none', not 'nobody looked'. " +
      "THE 7 TURF ROWS ALSO HAVE A BLANK COLOUR, for a different reason: the source repeats the range name in the colour column, which is not a colour. " +
      "SOMWALL 1.3mm AND 2.0mm ARE WALL CLADDING, NOT FLOORING. They are the only two ranges whose slip rating reads N/A, which is what a wall product would say. Both are flagged so nobody specifies them as a floor. " +
      "TURF IS PRICED PER LINEAL METRE, NOT PER m2, and two ranges are sold in two widths at two different per-lm rates — Leisure Lawn Plus is $111.48/lm at 3.70m and $55.76/lm at 1.85m, Test Wicket $128.24 and $64.12. The narrow roll is about half the wide one because it is half the width, so comparing the two per-lm figures without the width is meaningless. " +
      "THE 3 WELD RODS PRINT THE SAME NUMBER IN ALL THREE PRICE COLUMNS — $2.15, $3.00, $2.15 per metre — so they are seeded as flat rates with no break at all. An identical rate is not a price break, and seeding it as one would have the app announce a saving of zero dollars. Nomad Plus turf is the same shape for a different reason: the list prints only one rate for it. " +
      "NEEDLE PUNCH SITS IN THE CARPET CATEGORY. It is roll goods priced per m2 and cut the way broadloom is, so it belongs with carpet rather than in a category of its own, and each row says 'Needle punch' so it is never mistaken for tufted broadloom. SYNTHETIC TURF GOT ITS OWN CATEGORY, because it is not a floor covering and should never appear in a flooring comparison. " +
      "ALL SAMPLE, DISPLAY STAND AND HAND SWATCH ITEMS WERE EXCLUDED AT SOURCE, by the supplier workbook itself. Nothing was dropped on this side. " +
      "PRICES ARE 8 MONTHS OLD as at Sep 2026 — issued 1 February 2026, the only date in the file. Newer than Tarkett's 15-month-old quote and older than Chaparral's June 2026 list. " +
      "STILL UNSTATED AND WORTH ASKING: product weight (which is what blocks country forwarding), lead times and stock status of any kind, minimum order, warranty, acoustic ratings, roll length on the needle punch and turf beyond the printed metres, and whether the over-300 m2 rate is per order or per colour — the list says 'over 300m2' and nothing more.",
    fees: [
      {
        name: "Commercial vinyl cut-length baling",
        kind: "baling",
        // $20 PER CUT LENGTH. No "cut length" basis exists, and `each` is the
        // closest honest fit — a cut length IS one item off a roll. The
        // supplier's own wording is in the condition so nothing is lost.
        basis: "each",
        amount: 20,
        amountIncludesGst: false,
        // NOT AUTOMATIC. It only bites on a cut, and whether this order is a
        // cut or a whole roll is not something the charge engine can see.
        autoApply: false,
        effectiveFrom: "2026-02-01",
        effectiveUntil: null,
        condition:
          "TICK ON A COMMERCIAL VINYL CUT LENGTH. MJS word it '$20 per cut length' and it applies to all commercial vinyl cut lengths. One charge per cut length on the order, so two cuts is $40. " +
          "Not charged on a full roll. Nothing to tick on a whole-roll order.",
        notes:
          "Separate from, and on top of, the cut RATE. The 17.5% cut premium is already inside the printed cut price per m2; this $20 is a flat handling charge for baling the cut, and the two are not the same thing. Left unticked because the order shape decides it.",
        sortOrder: 10,
      },
      {
        name: "Residential sheet half-roll baling",
        kind: "baling",
        // $50 PER HALF ROLL. There is no half-roll basis, so `roll` is the
        // nearest — the supplier's wording stays in the condition.
        basis: "roll",
        amount: 50,
        amountIncludesGst: false,
        autoApply: false,
        effectiveFrom: "2026-02-01",
        effectiveUntil: null,
        condition:
          "TICK ON A RESIDENTIAL SHEET HALF ROLL. MJS word it '$50 per half roll' against a 15 L/M residential sheet roll. The basis here reads 'roll' because no half-roll basis exists — enter it once per half roll, not once per full roll. " +
          "Residential sheet is Inspire, Easy Living, Trojan and Trojan Plus, all 4m wide x 30lm full rolls.",
        notes:
          "Dearer than the commercial vinyl baling ($50 against $20) on a cheaper product, so it is worth checking on any small residential sheet order: on 15 L/M of Trojan at $19.90/m2 cut the goods are $1,194.00 and the baling is another $50.00.",
        sortOrder: 20,
      },
      {
        name: "Tru Turf cut-length baling",
        kind: "baling",
        basis: "each",
        amount: 50,
        amountIncludesGst: false,
        autoApply: false,
        effectiveFrom: "2026-02-01",
        effectiveUntil: null,
        condition:
          "TICK ON A TRU TURF CUT LENGTH. MJS word it '$50 per cut length' and it applies to all Tru Turf cut lengths. One charge per cut length, so two cuts is $100. Not charged on a full roll. " +
          "Tru Turf is the 7 synthetic turf lines — Leisure Lawn Elite and Plus, Test Wicket, Urban Sport, Nomad Plus.",
        notes:
          "Turf is priced per lineal metre, so a 'cut length' here is metres off a 20 or 30 lm roll rather than m2. $50 on a 5 lm cut of Leisure Lawn Plus ($143.33/lm cut = $716.65) is 7% of the goods, which is enough to matter on a small job.",
        sortOrder: 30,
      },
      {
        name: "Metro forwarding (NOT USED on a normal order — reference only)",
        kind: "delivery",
        basis: "order",
        amount: 85,
        amountIncludesGst: false,
        // NEVER AUTOMATIC. MJS deliver direct to the Terra shop free, so a
        // normal order must never carry this. Unlike Chaparral's delivery row
        // this one CAN legitimately be ticked, because a forwarded order is a
        // real thing that really costs $85 — it just is not how Terra buy.
        autoApply: false,
        effectiveFrom: "2026-02-01",
        effectiveUntil: null,
        condition:
          "DO NOT TICK ON A NORMAL ORDER. MJS deliver direct to the Terra shop and charge nothing for it. This $85/order applies only to a floorcoverings order FORWARDED ex another MJS location, per the price list, which is not how Terra buy. " +
          "It is a real MJS charge and it can be ticked if an order ever is forwarded, so this is unlike Chaparral's delivery row, which must never be billed at all.",
        notes:
          "COUNTRY FORWARDING IS NOT SEEDED, by Damien's call, so it is recorded here instead: $85 base plus $0.30/kg on sheet and turf rolls, or $0.10/kg on floorcovering pallets such as LVT. It could not be modelled honestly anyway — the per-kg leg needs a product weight the February 2026 list does not publish on any of the 104 lines. Terra are on the Gold Coast and buy metro.",
        sortOrder: 40,
      },
    ],
  },
  {
    code: "armstrong",
    name: "Armstrong Flooring",
    // Not stated anywhere in the workbook.
    shipsFrom: "",
    // CONFIRMED TRUE, by Damien, on the corrected list. Armstrong deliver to
    // Terra's warehouse and charge a flat $150 an order for it. The first
    // import had to leave this false with the freight position unknown,
    // because the old workbook published nothing about freight at all.
    deliversDirect: true,
    freightMethod: "Delivered to Terra's warehouse by Armstrong",
    freightNote:
      "FREIGHT IS KNOWN AND PRICED: $150 FLAT AN ORDER EX GST, INCLUSIVE OF ALL FEES, delivered to Terra's warehouse. Confirmed by Damien with Armstrong. It is seeded as an auto-applying delivery fee, so it lands once an order and never per line, and it is never folded into a per-m2 rate. " +
      "Inclusive of all fees means exactly that: no baling, no split pallet, no futile delivery, no fuel, no metro or country split. One line, $150, whatever is on the order. If Armstrong ever start charging any of those separately, they go in as their own fee rules and this note changes with them. " +
      "THIS REPLACES THE OLD 'FREIGHT UNKNOWN' POSITION. The first Armstrong import said freight was a blank page in the workbook, which was true of that workbook and is no longer the position. " +
      "THE OLD ARMSTRONG FEE SCHEDULE IS STILL NOT REVIVED, on standing instruction. The 23 Sep 2026 owner call deleted the previous Armstrong supplier and fee rows, and the figures recorded there (metro freight, building-site delivery, futile delivery, split pallet, baling, overnight bag, storage per pallet per week, crate-return credit, cutting fee, colour premium) are reference only. The $150 is Damien's current confirmed number and is the only Armstrong fee seeded. Two of the old ones are superseded outright: the cutting fee is the +15% cut uplift ON THE PRODUCT, and no colour premium is published on this list.",
    // No fuel row anywhere on this list, unlike Tarkett's 2.1% and Chaparral's
    // $2/lm, and the $150 is inclusive of all fees in any case.
    fuelSurchargeActive: false,
    // THE LIST NOW CARRIES ITS OWN DATE, on the Pricing Notes sheet, and
    // Damien confirmed it. The first import had no date at all and the age of
    // those rates was unknown.
    priceListEffectiveFrom: "2026-05-18",
    priceListSource:
      "Armstrong Partner Price List effective 18 May 2026 plus Armstrong website screenshots, owner-supplied corrected workbook (Armstrong_Final_Product_Price_List_FIXED). The list states its own effective date on its Pricing Notes sheet.",
    // ANSWERED. The list answers it itself, in writing, on its own notes sheet.
    dealerPricingNote:
      "ANSWERED, AND IT WAS THE HIGHEST-VALUE QUESTION ON THIS SUPPLIER. The corrected list's Pricing Notes sheet states it plainly: where Armstrong publish dealer pallet and dealer standard pricing, those dealer prices are Terra's cost prices. It names the ranges: Kingswood, Queenstown, Chesterfield, Aspirations and Longplank. " +
      "So 86 rows across 7 ranges (Kingswood 1.2 and 1.5, Queenstown 1.2 and 1.5, Chesterfield, Aspirations, Natural Creations Longplank) are seeded at dealer rates, and those rates sit well below what the first import carried. " +
      "CHESTERFIELD IS THE ONE PRICE IN THIS SUPPLIER THAT IS NOT THE PRINTED ONE. The workbook prints $12.75/m2 on a pallet on both of its sheets. Damien confirmed $12.95/m2 with Armstrong, so $12.95 is what is seeded, with the printed figure kept beside it in code and asserted at extract time so a change at Armstrong's end cannot slip past unnoticed. Worth a final word with Armstrong to close it out, since the paper and the phone call disagree by 20 cents a metre. " +
      "The 7 Sep 2026 pilot parse of an EARLIER Armstrong document, which recorded a dealer price conditional on a credit account and samples with Chesterfield at $20.60, is superseded and is reference only. It was a different document, not this list read twice.",
    notes:
      "355 lines across 31 ranges and 38 printed sizes, the largest single supplier list in the book by colour count. 276 vinyl (sheet, safety, wall, VCT, LVT), 31 carpet tile and carpet plank, 24 hybrid, 24 laminate. Every line is per m2 ex GST, with no lineal-metre or per-sheet pricing anywhere. " +
      "THIS IS THE SECOND IMPORT OF ARMSTRONG AND IT CLOSED FOUR OF THE FIVE BIG GAPS. The first import ran off an earlier workbook. Armstrong then supplied a corrected list, and on it: every pallet row prints a threshold, the Natural Creations 'various sizes' rows print a real size and pack each, the list states its own effective date, and the pricing notes confirm the dealer rates. Freight came from Damien rather than the list. " +
      "FIVE PRICE SHAPES, TAKEN FROM THE LIST'S OWN Price Rule COLUMN RATHER THAN INFERRED. 177 rows across 14 ranges are FULL-ROLL rates with a +15% uplift for a part roll. 31 rows print a plain pallet and standard pair. 86 rows print a DEALER pallet and dealer standard pair. 56 rows (Natural Creations ArborArt, EarthCuts, XL) print the pallet threshold per colour and size rather than once per range. 5 rows (Excelon VCT) print the same rate either side of the pallet. " +
      "THE PALLET BREAKS ARE LIVE NOW. 173 rows across 16 ranges carry a real volume rate and a real printed threshold, so a big enough order earns the pallet rate by itself. On the first import all 39 pallet rows had to be seeded dormant at the dearer rate, because the old list printed a pallet PRICE and never a pallet QUANTITY. costPrice is the standard rate, which is what a normal order pays, and the pallet rate is the break on top of it. " +
      "THE THRESHOLD IS USED EXACTLY AS PRINTED, NEVER ROUNDED TO A WHOLE PACK. Two variants do not divide cleanly: Aspirations prints a 145.6 m2 pallet against a 2.245 m2 pack (64.855 packs) and EarthCuts Standard 610 x 305mm prints 225.72 m2 against a 1.5 m2 pack (150.480 packs). Both carry a loud note and no carton-per-pallet figure rather than a tidied-up number. Worth confirming the pallet make-up on those two with Armstrong. " +
      "EXCELON VCT HAS NO PALLET DISCOUNT AND THAT IS A REAL FINDING, NOT A GAP. Armstrong print $17.28/m2 above and below the 239.76 m2 pallet, so the quantity is for ordering and carton counting only. No volume break is seeded on those 5 rows, deliberately, because the resolver only counts a volume rate that is strictly cheaper and announcing a saving of zero dollars would be worse than saying nothing. The extractor asserts the two rates stay equal, so a real discount appearing there fails the import instead of passing silently. " +
      "THE PALLET PREMIUM IS NOT ONE NUMBER, so neither printed rate is ever derived from the other. The carpet ranges sit near +10%, Sphere Cushion Back at +9.98%, Kingswood 1.2 at +14.51%, Chesterfield at +15.44% on the confirmed rate, Natural Creations XL at +7.65%. Both figures are stored exactly as printed on every row. " +
      "THIS IS THE FIRST SUPPLIER IN THE BOOK TO USE cutUpliftPct. The column was built for Armstrong's shape and until this supplier no seeded row exercised it. Armstrong publish a PERCENTAGE where Polyflor, MJS and Hurford's publish a second dollar price, so the percentage is what is stored and the resolver does the arithmetic once at quote time. The 15% is not a rule of thumb: every cut cell in the source workbook literally reads '=base x 1.15' and that is asserted cell by cell on all 177 roll rows at extract time. The workbook holds no cached formula results at all, so the cut rate is computed off the asserted formula rather than read from a stale cell. " +
      "NO SKUs EXIST IN THE SOURCE AT ALL. Not one of the 355 rows carries a product code, so `sku` is blank throughout and identity is range plus colour plus printed size. The size is in the key on every row because EarthCuts print Concrete, Sandstone and Slate at two different tile sizes each, so range plus colour alone collides on three rows. That is not missing data to chase, the list has no code column. " +
      "WALLFLEX IS WALL CLADDING, NOT FLOORING. 13 colours, the only Wall Vinyl category on the list, 1.50m x 20m roll, flagged the same way Tarkett's Wallgard and MJS's Somwall are so nobody specifies it as a floor. " +
      "SAFETY VINYL IS SPLIT BY SLIP RATING INTO SEPARATE PRICED RANGES: Safeguard R10 at $26.78/m2 a roll, R11 and R12 both at $29.57. So the rating is chosen before the price, not after. Accolade Foothold, Accolade Safe and Natralis Foothold are marketed as safety ranges but carry NO printed R-number, and the rating is left blank rather than borrowed off a sibling range. " +
      "SAFEGUARD'S '2mm / 1.50' IS A GRIP TEXTURE, NOT TWO GAUGES. It is Armstrong's raised slip-resistant surface, where the wear layer runs up and down by about 1.50mm across a 2mm sheet to make the grip underfoot. Gauge is therefore recorded as 2mm on all 18 Safeguard rows, where the first import left it blank as ambiguous. " +
      "ONE AMBIGUITY IS LEFT IN THE SOURCE AND IT IS NOT GUESSED. Armalon NG Colours, 8 rows, prints TWO roll widths (1.83m x 20m or 1.525m x 24m) and does not say which colour comes on which. Both work out at 36.6 m2 a roll so the roll threshold is safe either way, but the WIDTH is null, because quoting lineal metres off the wrong width is 20% out. Confirm the width with Armstrong before ordering a cut length. Armalon NG Black is a 1.20m roll, not the 1.83m the rest of the sheet vinyl comes on, which is not ambiguous but is unusual enough to flag. " +
      "PACK AND CARTON COUNTS ARE DERIVED FROM THE PRINTED FACE SIZE, NOT TRUSTED FROM THE PRINTED CARTON m2, and the two are reconciled at extract time. Kingswood 1.2 is the worst drift: 11 boards of 0.2196 m2 is 2.4156 against a printed 2.42. The integer piece count is the source of truth for ordering; the printed figure is kept for checking an invoice. " +
      "NO LEAD TIME OR STOCK DATA EXISTS ON THIS LIST IN ANY FORM, and Damien rings Armstrong before ordering on every product regardless, so no row claims a lead time and none claims stock. Always confirm availability before committing a date to a customer. " +
      "ONE FEE, AND IT IS CONFIRMED: $150 flat an order ex GST, delivered to the warehouse, inclusive of everything. See the freight note. " +
      "STILL UNSTATED AND WORTH ASKING, IN ROUGH ORDER OF WHAT IT IS WORTH: Chesterfield's pallet rate on paper ($12.75 printed against the $12.95 Damien confirmed), which colours of Armalon NG Colours come on the 1.83m roll and which on the 1.525m, the pallet make-up on the two variants whose threshold is not a whole number of cartons, minimum order, warranty, acoustic ratings, and product weight.",
    fees: [
      {
        name: "Delivery",
        kind: "delivery",
        basis: "order",
        amount: 150,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$150 + GST PER ORDER, flat, delivered to Terra's warehouse. Confirmed by Damien with Armstrong and INCLUSIVE OF ALL FEES: no baling, no split pallet, no futile delivery, no fuel surcharge, no metro or country split. Auto-applies to every Armstrong order, and it is per order, not per line and not per roll, unlike Polyflor's $20 baling fee.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "floordistributors",
    name: "Floor Distributors",
    // The list says it in writing on its Freight & Terms sheet: "All prices ex
    // GST and quoted ex Smithfield warehouse." Smithfield is in Sydney, which
    // is why every freight line on the sheet is written from there.
    shipsFrom: "Smithfield warehouse (NSW)",
    // THE CHAPARRAL SHAPE, CONFIRMED BY DAMIEN. Floor Distributors publish a
    // full freight schedule and Terra pays none of it. Stock lands at their
    // Brisbane depot and Terra's own courier collects it from there, in
    // Damien's words: "our own courier from the brisbne depot where they drop
    // it". So every delivery line on their sheet is reference only and the
    // real cost belongs to whichever carrier does the run.
    deliversDirect: false,
    freightMethod: "Terra's own courier, collected from Floor Distributors' Brisbane depot",
    freightNote:
      "FLOOR DISTRIBUTORS DO NOT DELIVER TO TERRA. Their stock is dropped at their Brisbane depot and Terra's own courier collects it from there and Terra pays that carrier directly. Confirmed by Damien: \"no our own courier from the brisbne depot where they drop it\". Put the real courier cost in the Transport field on the order cost, where it stays separately identifiable from the supplier's own charges. " +
      "SO THE PRINTED FREIGHT SCHEDULE IS REFERENCE ONLY, ALL OF IT: $95 per pallet metro, $75 per bundle or $35 with a pallet consignment, $125 oversized, $65 per pallet regional within 15km of Smithfield. Four unticked fee rows carry those numbers so they are on file, and `deliversDirect: false` makes the charge engine refuse a delivery-kind fee on this supplier even if someone ticks one by hand. " +
      "THE METRO PALLET RATE DOES NOT APPLY TO THE GOLD COAST, asked and answered directly. Brisbane is named in their metro list and Terra is not in Brisbane, and in any case Terra is collecting rather than being delivered to, so the $95 never reaches a Terra order. " +
      "ONE CHARGE IS GENUINELY TERRA'S AND IT AUTO-APPLIES: picking and bailing, $29.50 ex GST, on every order, per their own sheet. It is a handling charge and not a delivery charge, so `deliversDirect: false` does not touch it and it lands once an order. " +
      "THE URGENT $35 PACKING CHARGE IS REAL BUT CONDITIONAL, so it is on file unticked: same-day Brisbane pickup or dispatch only. Tick it by hand on an order that is actually rushed.",
    // No fuel row anywhere on this list. Unlike Tarkett's 2.1% and Chaparral's
    // $2/lm, freight here is a flat schedule Terra does not pay in any case.
    fuelSurchargeActive: false,
    // DELIBERATELY BLANK. The list prints no effective date anywhere and
    // Damien has not named one, so nothing is carried rather than a guess.
    // Same treatment as any other undated list in the book. WORTH ASKING
    // Floor Distributors for the date on the sheet.
    priceListSource:
      "Floor Distributors independent price list, owner-supplied workbook (Floor_Distributors_Independent_Price_List_FIXED). Per m2 ex GST, quoted ex Smithfield warehouse. The list prints NO effective date.",
    notes:
      "72 flooring colours across 9 ranges, plus 45 accessories and 1 underlay. Engineered timber (Balmain Oak 14mm, Balmain Oak Wide 15mm, Balmain Feature 14mm, Federation Plank 14mm, Federation Plank 14mm Rustic), hybrid (Viva Classic, Viva Original, Viva Planks) and vinyl plank (Viva Luxury Vinyl Plank). Every flooring line is per m2 ex GST. " +
      "PRICE IS PER COLOUR, NOT PER RANGE, ON FOUR OF THE NINE RANGES, so no colour ever inherits a range rate: Balmain Feature 14mm runs $45.00, $47.50 and $49.50, Balmain Oak 14mm $59.50 and $61.50, Balmain Oak Wide 15mm $69.50 and $74.00, Federation Plank 14mm $79.90 and $82.90. The three Viva hybrids are flat at $23.90 and Viva Luxury Vinyl Plank is flat at $24.90. " +
      "FEDERATION PLANK IS PRICED BY BOARD LENGTH, WHICH IS THE ONE PRICING TRAP ON THIS SUPPLIER. The same colour in the same range costs $79.90/m2 at 1830mm and $82.90/m2 at 2190mm, so length is part of the variant identity and quoting a Federation colour without naming the length is quoting the wrong price. The Rustic sibling range is $75.90 at BOTH lengths, so the trap is on the non-rustic rows only. " +
      "ALL FLOORING IS SOLD IN FULL PACK QUANTITIES ONLY, per their own terms sheet. No part boxes, so the box m2 is the ordering unit on every flooring row. " +
      "BOX AND PALLET COUNTS ARE DERIVED FROM THE PRINTED BOARD SIZE, NOT TRUSTED FROM THE PRINTED BOX m2, and the two are reconciled at extract time on all 72 rows. The integer board count is the source of truth for ordering and the printed figure is kept beside it for checking an invoice. " +
      "ONE PALLET DOES NOT DIVIDE WHOLE AND IT IS LEFT NULL RATHER THAN ROUNDED. Viva Luxury Vinyl Plank prints 111.5 m2 a pallet against a 2.787 m2 box, which is 40.006 boxes. A whole 40 boxes is 111.48 m2, so the printed pallet figure is a rounded one, and all 20 rows of that range carry no box-per-pallet count at all. Worth confirming the pallet make-up with Floor Distributors. " +
      "THERE IS NO PALLET PRICE BREAK ON THIS SUPPLIER, asked and answered: \"forget this\". The full-pallet m2 figure on every row is freight and ordering information only and is never a cheaper rate. Nothing on this supplier carries a volume break except the underlay. " +
      "THE UNDERLAY IS THE ONLY VOLUME BREAK, AND ONLY TWO OF ITS THREE PRINTED TIERS ARE SEEDED. Performance Plus with Damp Protect (PP50, 50m rolls) prints $2.05 for 1-9 rolls, $1.95 for 10-20 and $1.85 over 20. Damien's call: \"Standard $2.05 with the break at 20 rolls to $1.85, ignore the middle tier.\" So the standard cost is $2.05/lm and the break is at 1000 lineal metres, which is 20 rolls. The middle tier is recorded in code for the audit trail and is deliberately not seeded. " +
      "29 OF THE 72 FLOORING ROWS ARE JOINED TO A MATCHING SCOTIA CODE off the colour label the flooring sheet prints, against the Designer Profile Scotia items (DPTS17...) on the accessories sheet. One of those joins is INFERRED rather than printed and is flagged in code. The Viva accessories name their range in prose brackets instead of printing a code, e.g. \"(Classic + Planks)\", and every range they claim was checked to exist. " +
      "VIVA STAIR IS SCRAPPED AND IS NOT SEEDED, on Damien's instruction: \"dont use it, scrap it.\" Its code prints literally as an ellipsis with no colour codes published at all, so nothing under it was orderable. It is recorded in FLOORDISTRIBUTORS_DROPPED so a later list can be compared against what was left out. " +
      "FOUR SOURCE CONFLICTS ARE RECORDED RATHER THAN SILENTLY RESOLVED, all in FLOORDISTRIBUTORS_CONFLICTS and all worth one call to Floor Distributors: BAL14NO Natural Oak prints a matching scotia of \"Oak\" which is not a scotia colour; BAL15WBNO Brushed Natural Oak prints Blackbutt scotia while DPTS17SAND's own description claims \"Brush Nat\"; the two Federation Spotted Gum rows print Blackbutt Scotia as their match even though a Spotted Gum scotia exists; and VCSTAO is sold as Viva Custom Stair Antique Oak (Classic) when Antique Oak is not a Viva Classic colour. Where the two sheets disagree the FLOORING row wins, because that is the row being quoted. " +
      "RETURNS ARE DEAR AND ARE NOT A COST LINE ANYWHERE: 15% on first quality flooring, 25% on first quality trims, subject to their conditions. Terms are nett 30 days. Both are on file in FLOORDISTRIBUTORS_TERMS verbatim. " +
      "STILL UNSTATED AND WORTH ASKING, IN ROUGH ORDER OF WHAT IT IS WORTH: the effective date of this price list, the pallet make-up on Viva Luxury Vinyl Plank, the four scotia conflicts above, minimum order, lead time and stock position on every range, warranty, and wear layer on the engineered timber rows (the sheet prints one for the vinyl and hybrid and leaves it blank on timber).",
    fees: [
      {
        name: "Picking & Bailing",
        // Handling, NOT delivery. This distinction is what lets it auto-apply
        // on a supplier whose delivery charges are all held back.
        kind: "handling",
        basis: "order",
        amount: 29.5,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$29.50 + GST ON EVERY ORDER, flat, per their own Freight & Terms sheet: \"Picking & bailing $29.50 + GST applies to all orders.\" The ONLY Floor Distributors charge Terra genuinely pays, confirmed by Damien. Per order, not per pallet and not per line, so a one-box order and a full-pallet order both carry $29.50.",
        notes:
          "Not flagged temporary and not conditional on anything. Everything else on their freight schedule is a delivery charge Terra never pays, because Terra collects from their Brisbane depot with its own courier.",
        sortOrder: 10,
      },
      {
        name: "Urgent Brisbane same-day packing",
        kind: "handling",
        basis: "order",
        amount: 35,
        amountIncludesGst: false,
        // CONDITIONAL, so not automatic. It is a real Terra cost when it
        // bites, unlike the delivery rows below, so it is tickable by hand.
        autoApply: false,
        condition:
          "TICK ONLY ON A GENUINELY RUSHED ORDER. $35 + GST, per their terms sheet: \"Urgent Brisbane order: same day pickup/dispatch attracts $35 + GST packing charge.\" It is ON TOP of the $29.50 picking and bailing, not instead of it. Not automatic because most orders are not same-day.",
        notes:
          "The one conditional charge on this supplier that Terra really does pay when it applies, since it is packing rather than freight. Their sheet does not say what the cut-off time for same-day is, which is worth asking if rush orders become common.",
        sortOrder: 20,
      },
      {
        name: "Metro pallet freight (NOT USED, reference only)",
        kind: "delivery",
        basis: "pallet",
        amount: 95,
        amountIncludesGst: false,
        // NEVER AUTOMATIC. Two guards: autoApply off, and deliversDirect:false
        // makes the charge engine refuse it with a reason even if ticked.
        autoApply: false,
        condition:
          "DO NOT TICK. Their published rate, $95 + GST per pallet to Sydney, Melbourne, Brisbane and Adelaide metro. Terra never pays it: stock is dropped at their Brisbane depot and Terra's own courier collects it, so charging this too would bill the same freight twice. AND THE GOLD COAST IS NOT IN THEIR METRO LIST IN ANY CASE, confirmed with Damien directly. On file so the number is known, not so it can be used.",
        notes:
          "Printed on their Freight & Terms sheet verbatim. The most likely of these four rows to be ticked by mistake, because Brisbane appears in the wording and reads close enough to the Gold Coast to look right.",
        sortOrder: 30,
      },
      {
        name: "Bundle freight (NOT USED, reference only)",
        kind: "delivery",
        basis: "shipment",
        amount: 75,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "DO NOT TICK. Their published rate, $75 + GST per bundle, or $35 + GST when the bundle travels with a pallet consignment. Terra collects from their Brisbane depot and pays its own courier, so neither figure is ever a Terra cost. The $35 accompanying rate is NOT modelled as its own row, which is harmless while this stays unticked.",
        notes: "Printed on their Freight & Terms sheet verbatim.",
        sortOrder: 40,
      },
      {
        name: "Oversized freight (NOT USED, reference only)",
        kind: "delivery",
        basis: "shipment",
        amount: 125,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "DO NOT TICK. Their published oversized rate, $125 + GST. Terra collects from their Brisbane depot and pays its own courier. Their sheet does not say what counts as oversized, which is another reason it could never be applied accurately here.",
        notes: "Printed on their Freight & Terms sheet verbatim, with no definition of oversized given.",
        sortOrder: 50,
      },
      {
        name: "Regional pallet freight (NOT USED, reference only)",
        kind: "delivery",
        basis: "pallet",
        amount: 65,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "DO NOT TICK. Their published regional position: by quotation, or a flat $65 per pallet to a preferred carrier within 15km of the Smithfield warehouse. That is a Sydney-radius rate and has nothing to do with a Gold Coast order, and Terra pays its own courier in any case.",
        notes:
          "Printed on their Freight & Terms sheet verbatim. The $65 is the flat-to-carrier figure; regional delivery proper is by quotation, which cannot be modelled as an amount at all.",
        sortOrder: 60,
      },
    ],
  },
  {
    code: "karndean",
    name: "Karndean",
    // THE MIRROR OF CHAPARRAL AND FLOOR DISTRIBUTORS, and the reason to read
    // this block beside those two. Karndean truck it to Terra's own warehouse
    // themselves for a flat $80 an order, confirmed by Damien, so
    // deliversDirect stays TRUE and the delivery fee is real and automatic.
    // Nothing is held back on this supplier.
    deliversDirect: true,
    freightMethod: "Karndean's own delivery to Terra's Gold Coast warehouse",
    freightNote:
      "$80 EX GST FLAT AN ORDER, AUTOMATIC, confirmed by Damien. Karndean deliver it themselves, so unlike Chaparral and Floor Distributors there is no second carrier to pay and no reason to hold the charge back. Per order and flat, so a one-box order and a ten-box order both carry $80, which makes a small Karndean order dear per m2 and is worth saying out loud when quoting one box. " +
      "TWO PER-m2 LEVIES STACK ON TOP OF THE RATE AND BOTH ARE REAL: a fuel surcharge at $0.40/m2 and the Resiloop recycling levy at $0.09/m2, 49c/m2 together. Both auto-apply, both are on an m2 basis, and NEITHER IS INSIDE THE PRICE LIST RATES. On a 3.15 m2 LooseLay box that is $1.26 fuel and 28c Resiloop, in Damien's own words: \"they charge fuel suracharge 0.40c so at 3.15m2 box i pay $1.26\".",
    // The fuel surcharge is a kind:"fuel" fee row on an m2 basis, which is
    // where the charge engine reads it. These display-only fields stay off:
    // the percentage ones cannot hold a per-m2 figure.
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2023-08-14",
    priceListSource:
      "Karndean Silver Australia price list effective 14 August 2023, owner-supplied workbook (Karndean_Australia_Colours_and_Prices). Per m2 ex GST. Colour names and product codes come from official Karndean AU/ANZ range pages and brochures, per the workbook's own Audit Notes sheet.",
    notes:
      "193 colours across 12 ranges and 15 range/size families, every one of them vinyl and every rate per m2 ex GST. LooseLay Originals (wood and stone), LooseLay Longboard, Knight Tile, Van Gogh, Korlok 5G and Art Select (Oak Royale, Handcrafted, Oak Premier, Parquet). Nine rates on the whole list: $25.00, $28.81, $33.13, $35.69, $36.67, $42.29, $45.30, $58.48 and $65.03. " +
      "DAMIEN CONFIRMED THE 2023 RATES ARE STILL CURRENT, so they are seeded as they stand with no stale-price flag. " +
      "THE 49c OF LEVIES IS THE FIRST THING TO GET RIGHT ON THIS SUPPLIER. Fuel $0.40/m2 and Resiloop $0.09/m2 are separate auto-applying per-m2 fee rows and are NOT in the rates above. This is the OPPOSITE of Tarkett, who quote their 9c Resiloop already inside the price and therefore carry no Resiloop fee row at all. Copying Tarkett's treatment onto Karndean would undercharge every Karndean quote by 49c/m2, and copying Karndean's onto Tarkett would double-charge their 9c. " +
      "GLUEDOWN AND RIGID CORE ARE TWO DIFFERENT PRODUCTS AT TWO DIFFERENT PRICES, WHICH IS THE PRICING TRAP HERE. 48 colours across Knight Tile and Van Gogh are published in both, and they share the colour NAME and nothing else: different product code, different board size, different m2 per box and a different rate. Knight Tile is $25.00 gluedown against $28.81 rigid core, Van Gogh $33.13 against $35.69. Quoting a Knight Tile or Van Gogh colour without naming the format is quoting the wrong price, so format is part of the variant identity and every row carries a cross-reference to its opposite number. " +
      "TWO RANGE NAMES EACH COVER A WOOD FAMILY AND A STONE FAMILY AT DIFFERENT SIZES AND BOX QUANTITIES, so the range name alone does not price a job. Korlok 5G runs 1420x225mm at 3.195 m2 a box for the wood and 600x457mm at 2.742 for the stone, both at $42.29. Knight Tile runs 1219x178mm wood and 305x457mm stone in gluedown and 1220x180mm wood and 305x457mm stone in rigid core. The size is what identifies the family. " +
      "PACK QUANTITIES ARE DERIVED FROM THE PRINTED BOARD SIZE AND THEN RECONCILED AGAINST THE PRINTED BOX m2 ON ALL 193 ROWS, same treatment as Floor Distributors. The whole-piece count is the source of truth for ordering and the printed figure is kept beside it for checking an invoice. NINE OF THE 15 FAMILIES PRINT A ROUNDED BOX m2: Art Select Handcrafted and Oak Premier print 3.345 against a real 3.33792 (24 pieces at 0.13908), Knight Tile gluedown wood prints 4.335 against 4.33964, and so on. The differences are small but they are real, and a full-box order quoted off the printed figure is out by a few cents a box. " +
      "ONE PRICED RANGE IS DELIBERATELY NOT SEEDED. Opus Gluedown carries a rate of $30.95/m2 on the workbook's own Price List Basis sheet and not one colour is published for it anywhere on the product sheet, so there is nothing orderable behind the price. It is recorded in KARNDEAN_UNSEEDED_BASIS rather than invented into products. WORTH ASKING Karndean for the Opus colour range and codes if a customer wants it. " +
      "EVERY SEEDED RATE IS BACKED BY A ROW ON THE PRICE LIST BASIS SHEET, checked family by family at extract time, and that sheet gives its basis as \"Current display stand\" throughout. " +
      "NO VOLUME BREAK, NO PALLET RATE AND NO MINIMUM ORDER IS PRINTED ANYWHERE ON THIS LIST, so none is seeded. The only things that move the price of a Karndean order are the two per-m2 levies and the flat $80 freight. " +
      "THE WORKBOOK'S OWN AUDIT NOTES FLAG LOOSELAY LONGBOARD, and it is the one range worth a call before quoting big: Karndean announced another Australian LooseLay Longboard refresh in September 2026, which is this month. Its 20 colours are seeded at the confirmed $45.30 and that rate may be the thing that moves first. The same sheet warns more generally that some ranges have been refreshed since the 2023 list. " +
      "NOT PRINTED ON THIS LIST AND NOT INVENTED: wear layer, gauge, warranty and acoustic rating on every row, lead times and stock position, and accessories or adhesives of any kind. All worth asking for, the wear layer most of all, since it is the first thing a customer comparing Karndean against Terramater or Tarkett asks about.",
    fees: [
      {
        name: "Fuel Surcharge",
        kind: "fuel",
        // PER m2, not a percentage. Terramater's levy is a percent of the
        // order and Chaparral's is per lineal metre; this one is per square
        // metre, which is why the basis lives on the rule and not in a
        // supplier-wide percentage field.
        basis: "m2",
        amount: 0.4,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "AUTOMATIC ON EVERY ORDER, $0.40 ex GST per m2 ordered. Confirmed by Damien: \"they charge fuel suracharge 0.40c so at 3.15m2 box i pay $1.26\", which is this rate against a LooseLay Originals box. NOT inside the price list rates, so it is charged on top of them.",
        notes:
          "No end date given, so it stands until further notice, the usual wording on a fuel levy. Worth re-asking Karndean whenever fuel moves, because this is the kind of charge that changes without a letter.",
        sortOrder: 10,
      },
      {
        name: "Resiloop recycling levy",
        // A LEVY, NOT A FUEL SURCHARGE. Own kind so it can be seen and argued
        // separately on a quote, and so the Tarkett contrast stays legible.
        kind: "levy",
        basis: "m2",
        amount: 0.09,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "AUTOMATIC ON EVERY ORDER, $0.09 ex GST per m2 ordered, the industry vinyl recycling levy. Confirmed by Damien as charged ON TOP of the rate, which is 28c on a 3.15 m2 box.",
        notes:
          "THE CONTRAST WITH TARKETT IS THE WHOLE POINT OF THIS ROW. Tarkett's quote states their 9c Resiloop is already included in the rate, so Tarkett deliberately carry no levy row and adding one there would charge it twice. Karndean's is not included, so it must be a row here or every Karndean quote is 9c/m2 light. Same levy, same 9c, opposite treatment, decided per supplier on what their own paperwork says.",
        sortOrder: 20,
      },
      {
        name: "Delivery to Gold Coast warehouse",
        kind: "delivery",
        basis: "order",
        amount: 80,
        amountIncludesGst: false,
        // AUTOMATIC, and correctly so. `deliversDirect` is true on this
        // supplier, so the charge engine lets a delivery-kind fee through.
        autoApply: true,
        condition:
          "AUTOMATIC ON EVERY ORDER, $80 ex GST flat, confirmed by Damien. Karndean deliver to Terra's warehouse themselves. Flat per order regardless of size, so it is worth consolidating Karndean orders rather than ordering a box at a time.",
        notes:
          "Genuinely Terra's cost, unlike the delivery rows on Chaparral and Floor Distributors, which are held back because Terra pays its own carrier for that leg instead. Karndean is the supplier to look at when checking that the deliversDirect guard has not been applied too widely.",
        sortOrder: 30,
      },
    ],
  },
  {
    code: "dunlop",
    name: "Dunlop Flooring",
    deliversDirect: true,
    freightMethod: "Dunlop delivery to Terra's Gold Coast warehouse",
    freightNote:
      "$80 + GST per delivery, confirmed by Damien from the Dunlop hard-flooring boxed-products upload. Auto-applies as a supplier delivery fee and is not baked into any product rate.",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-09-30",
    priceListSource: "Dunlop Flooring Price List - Hard Flooring 30 Sep 2026, owner-supplied workbook",
    notes:
      "137 boxed hard-flooring rows across engineered timber, hybrid, laminate and LVT. Prices are per m2 ex GST. The workbook's Scope & Rules sheet explicitly excludes accessories, stairnose, adhesive, end profiles, scotia and T trims, so this supplier seed carries flooring only. No pallet discount exists in the supplied list, so product rates stay as the single standard m2 cost. Missing specs stay blank deliberately, nothing is guessed.",
    fees: [
      {
        name: "Delivery to Gold Coast warehouse",
        kind: "delivery",
        basis: "order",
        amount: 80,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$80 + GST per delivery, confirmed by Damien. Dunlop deliver to Terra's warehouse, so this is a real supplier delivery fee and auto-applies on Dunlop orders.",
        sortOrder: 10,
      },
    ],
  },
  {
    code: "advantageflooring",
    name: "Advantage Flooring",
    deliversDirect: false,
    freightMethod: "Jocks Carpet Express — roll freight to Terra's Gold Coast warehouse",
    freightNote:
      "Advantage Flooring does not deliver itself, so Terra books its own carrier. Jocks Carpet Express's own rate card (2025-03-01) charges $25 + GST per roll of carpet, plus their 25% fuel levy, so $31.25 ex GST per roll ($34.38 inc GST) is the real per-roll freight cost. Auto-applies as a supplier delivery fee on a per-roll basis, not baked into any product rate. Jocks also charge a $30 + GST minimum consignment and a $20 + GST pickup fee (fuel levy on the pickup fee is unconfirmed by the supplier) — both held back as reference-only, since it is not clear from the rate card when either is billed on top of the per-roll rate.",
    fuelSurchargeActive: false,
    priceListEffectiveFrom: "2026-05-01",
    priceListSource: "Advantage Flooring May 2026 price list (ADVANTAGE FLOORING MAY 2026.pdf), owner-supplied workbook",
    notes:
      "296 broadloom carpet colours across 39 ranges, per the workbook's own Import Rules sheet scoped to broadloom carpet only — marine carpet, carpet tiles, hybrid, vinyl planks and sheet vinyl are excluded. Prices are per lineal metre ex GST. No product codes are published anywhere in the source, so product identity is a generated composite key. Roll width is not published on any of the 296 rows, so lm cannot be converted to m2 — measure and quote in lm. 102 of 296 rows carry a genuine cut-length premium over the roll rate (differs row by row: $2, $5 or $10/lm), but no lm threshold is published for when the cut rate kicks in, so it is kept as reference only rather than wired into the roll/cut break. One range, Merindah (Opal Ef), has no confirmed colour — the workbook's own note says the colour list was not found on Advantage Flooring's current website, so its one colour line is left blank rather than guessed.",
    fees: [
      {
        name: "Jocks Carpet Express — roll freight",
        kind: "delivery",
        basis: "roll",
        amount: 31.25,
        amountIncludesGst: false,
        autoApply: true,
        condition:
          "$25 + GST per roll from Jocks Carpet Express's own rate card, plus their 25% fuel levy, so $31.25 ex GST per roll. Advantage Flooring does not deliver, so Terra pays this on every roll of Advantage carpet it books through Jocks.",
        sortOrder: 10,
      },
      {
        name: "Jocks Carpet Express — minimum consignment (NOT USED, reference only)",
        kind: "delivery",
        basis: "order",
        amount: 30,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "$30 + GST minimum consignment charge from Jocks Carpet Express's rate card, plus their 25% fuel levy ($37.50 ex GST). Held back — unclear from the rate card whether this replaces or stacks with the per-roll rate on a small order, so it does not auto-apply until confirmed with Jocks.",
        sortOrder: 20,
      },
      {
        name: "Jocks Carpet Express — pickup fee (NOT USED, reference only)",
        kind: "delivery",
        basis: "order",
        amount: 20,
        amountIncludesGst: false,
        autoApply: false,
        condition:
          "$20 + GST pickup fee from Jocks Carpet Express's rate card. Fuel levy application to this specific charge is NOT confirmed by the supplier (their own rate card flags it), so the ex-GST rate is left at the base $20 rather than guessed at $25, and it does not auto-apply.",
        sortOrder: 30,
      },
    ],
  },
];

async function main() {
  for (const seed of SUPPLIERS) {
    const { fees, priceListEffectiveFrom, priceListValidUntil, ...rest } = seed;
    const values = {
      ...rest,
      priceListEffectiveFrom: priceListEffectiveFrom ? new Date(priceListEffectiveFrom) : null,
      priceListValidUntil: priceListValidUntil ? new Date(priceListValidUntil) : null,
      fuelSurchargeUpdatedAt: seed.fuelSurchargeActive ? new Date() : null,
      updatedAt: new Date(),
    };

    const [existing] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, seed.code));
    const supplierId = existing
      ? (await db.update(s.suppliers).set(values).where(eq(s.suppliers.id, existing.id)).returning())[0].id
      : (await db.insert(s.suppliers).values(values).returning())[0].id;

    // Fees are replaced wholesale — the supplier's schedule is the source of truth.
    await db.delete(s.supplierFeeRules).where(eq(s.supplierFeeRules.supplierId, supplierId));
    if (fees.length) {
      await db.insert(s.supplierFeeRules).values(fees.map((f) => ({ ...f, supplierId })));
    }
    console.log(`${existing ? "updated" : "created"} ${seed.name} (${fees.length} fees)`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
