/**
 * Pure discount-offer matching rules.
 *
 * Kept free of database imports so the POS, the server pricing engine and the
 * unit tests all share exactly one definition of "does this offer apply?".
 *
 * An offer targets departments, categories and/or individual products. A
 * product matches when ANY selected target contains it — a product explicitly
 * selected always matches, and so does every product of a selected category or
 * department. When several offers match the same product, only the highest
 * percentage applies (offers never stack).
 */

export type OfferTargets = {
  productIds: string[];
  categoryIds: string[];
  departmentIds: string[];
};

export type OfferCandidate = OfferTargets & {
  id?: string;
  name?: string;
  percentage: number;
};

export type ProductTarget = {
  id: string;
  categoryId: string | null;
  departmentId: string | null;
};

/** True when at least one selected target contains the product. */
export function offerMatchesProduct(offer: OfferCandidate, product: ProductTarget): boolean {
  if (offer.productIds.length === 0 && offer.categoryIds.length === 0 && offer.departmentIds.length === 0) {
    return false;
  }
  if (offer.productIds.includes(product.id)) return true;
  if (product.categoryId && offer.categoryIds.includes(product.categoryId)) return true;
  if (product.departmentId && offer.departmentIds.includes(product.departmentId)) return true;
  return false;
}

/**
 * Highest-percentage matching offer, or null when none applies. On a tie the
 * first offer wins so the result is stable across queries.
 */
export function pickBestOffer(
  offers: OfferCandidate[],
  product: ProductTarget
): OfferCandidate | null {
  let best: OfferCandidate | null = null;
  for (const offer of offers) {
    const percentage = Number.isFinite(offer.percentage) ? offer.percentage : 0;
    if (percentage <= 0) continue;
    if (!offerMatchesProduct(offer, product)) continue;
    if (!best || percentage > best.percentage) best = { ...offer, percentage };
  }
  return best;
}
