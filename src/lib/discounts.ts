import mongoose from "mongoose";
import { DiscountOffer, Product } from "@/models";
import { pickBestOffer, type OfferCandidate } from "@/lib/discount-rules";

/**
 * Server-side resolution of active discount offers.
 *
 * A product's sellable discount is resolved from the offer documents, never
 * from the client: the POS only displays what this function returns, and the
 * sales service recomputes it at checkout so an offline/edited payload cannot
 * invent a discount. Date bounds are inclusive of the whole start and end day.
 */

export type ResolvedOfferDiscount = {
  offerId: string;
  name: string;
  percentage: number;
};

export type ResolveOfferOptions = {
  now?: Date;
  session?: mongoose.ClientSession | null;
};

function documentTargets(offer: Record<string, unknown>): OfferCandidate | null {
  const percentage = Number(offer.percentage ?? 0);
  if (!Number.isFinite(percentage) || percentage <= 0) return null;
  return {
    id: String(offer._id),
    name: String(offer.name ?? ""),
    percentage,
    productIds: ((offer.productIds ?? []) as unknown[]).map(String),
    categoryIds: ((offer.categoryIds ?? []) as unknown[]).map(String),
    departmentIds: ((offer.departmentIds ?? []) as unknown[]).map(String),
  };
}

/**
 * Resolves the best active offer for each of the given products.
 * Returns an empty map when no offer is running right now.
 */
export async function resolveOfferDiscountsForProducts(
  productIds: string[],
  options: ResolveOfferOptions = {}
): Promise<Map<string, ResolvedOfferDiscount>> {
  const result = new Map<string, ResolvedOfferDiscount>();
  const ids = [...new Set(productIds.filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (ids.length === 0) return result;

  const now = options.now ?? new Date();
  const session = options.session ?? null;

  const offerQuery = DiscountOffer.find({
    status: "active",
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).select("name percentage productIds categoryIds departmentIds");

  const offers = (await (session ? offerQuery.session(session) : offerQuery).lean()) as unknown as Array<
    Record<string, unknown>
  >;
  const candidates = offers
    .map(documentTargets)
    .filter((offer): offer is OfferCandidate => offer !== null);
  if (candidates.length === 0) return result;

  const productQuery = Product.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }).select(
    "categoryId departmentId"
  );
  const products = (await (session ? productQuery.session(session) : productQuery).lean()) as Array<{
    _id: mongoose.Types.ObjectId;
    categoryId?: mongoose.Types.ObjectId | null;
    departmentId?: mongoose.Types.ObjectId | null;
  }>;

  for (const product of products) {
    const best = pickBestOffer(candidates, {
      id: String(product._id),
      categoryId: product.categoryId ? String(product.categoryId) : null,
      departmentId: product.departmentId ? String(product.departmentId) : null,
    });
    if (!best) continue;
    result.set(String(product._id), {
      offerId: best.id ?? "",
      name: best.name ?? "",
      percentage: best.percentage,
    });
  }

  return result;
}
