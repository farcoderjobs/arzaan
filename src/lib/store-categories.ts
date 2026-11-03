import mongoose from "mongoose";
import { Category } from "@/models";

/**
 * Storefront category navigation, derived from the real MongoDB category
 * collection. Only active categories that actually have published (active)
 * store products are exposed — no hardcoded lists, no empty duplicates.
 *
 * Legacy store products may still carry a free-text `category` (no categoryId);
 * those names are merged by name so the nav never shows the same category twice.
 */

export type StorefrontCategory = {
  /** Stable key used by the client filter (`category:<id>` or `name:<name>`). */
  key: string;
  /** Human name from the database. */
  name: string;
  /** URL-safe slug used in `/?category=…` links. */
  slug: string;
  count: number;
};

type ProductCategorySource = {
  categoryId?: mongoose.Types.ObjectId | string | null;
  category?: string | null;
};

export function slugifyCategory(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function categoryKeyFor(product: ProductCategorySource): string {
  const id = product.categoryId ? String(product.categoryId) : "";
  if (id) return `category:${id}`;
  const name = (product.category ?? "").trim();
  return name ? `name:${name.toLowerCase()}` : "name:general";
}

export async function resolveStorefrontCategories(
  products: ProductCategorySource[]
): Promise<StorefrontCategory[]> {
  const ids = Array.from(
    new Set(
      products
        .map((p) => (p.categoryId ? String(p.categoryId) : ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  const categoryDocs = ids.length
    ? await Category.find({ _id: { $in: ids }, status: "active" })
        .select("name")
        .lean()
    : [];
  const activeNames = new Map(categoryDocs.map((c) => [String(c._id), c.name]));

  const byName = new Map<string, StorefrontCategory>();

  for (const product of products) {
    const key = categoryKeyFor(product);
    let name = "";
    if (key.startsWith("category:")) {
      name = activeNames.get(key.slice("category:".length)) ?? "";
      // Inactive / missing category rows are not published on the storefront.
      if (!name) continue;
    } else {
      name = (product.category ?? "").trim() || "General";
    }

    const dedupeKey = name.toLowerCase();
    const existing = byName.get(dedupeKey);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byName.set(dedupeKey, {
      key,
      name,
      slug: slugifyCategory(name),
      count: 1,
    });
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function findCategoryKeyBySlug(
  categories: StorefrontCategory[],
  slug: string | null | undefined
): string | null {
  const target = (slug ?? "").trim().toLowerCase();
  if (!target) return null;
  return categories.find((c) => c.slug === target)?.key ?? null;
}
