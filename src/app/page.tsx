import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLicenseState } from "@/lib/license";
import { connectDB } from "@/lib/mongodb";
import { StoreProduct } from "@/models";
import { getStoreSettings } from "@/lib/settings";
import { Storefront, StoreProductView } from "@/components/store/storefront";
import {
  categoryKeyFor,
  findCategoryKeyBySlug,
  resolveStorefrontCategories,
  type StorefrontCategory,
} from "@/lib/store-categories";

export async function generateMetadata(): Promise<Metadata> {
  try {
    await connectDB();
    const settings = await getStoreSettings(null);
    const name = settings.storeName && settings.storeName !== "POS System" ? settings.storeName : "Online Store";
    return {
      title: `${name} — Online Store`,
      description: "Browse our curated online store and order in minutes. We call you to confirm delivery.",
    };
  } catch {
    return { title: "Online Store", description: "Shop products from our online store" };
  }
}

// The storefront reads live product/stock data — never prerender it at build time.
export const dynamic = "force-dynamic";

export default async function StoreHomePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string | string[] }>;
}) {
  // The storefront ships with the same build: an expired subscription closes it
  // too, instead of quietly accepting orders nobody will fulfil.
  const license = await getLicenseState();
  if (license.blocked) redirect("/activate");

  const params = await searchParams;
  const requestedCategory = Array.isArray(params.category) ? params.category[0] : params.category;

  let products: StoreProductView[] = [];
  let categories: StorefrontCategory[] = [];
  let storeName = "Online Store";
  let currency = "AFN";
  let storePhone = "";
  let loadError = false;

  try {
    await connectDB();
    const settings = await getStoreSettings(null);
    if (settings.storeName) storeName = settings.storeName;
    currency = settings.currency || "AFN";
    storePhone = settings.phone || "";

    const docs = await StoreProduct.find({ status: "active" })
      .sort({ featured: -1, createdAt: -1 })
      .select("name slug description price compareAtPrice accent imageUrl category categoryId stock featured")
      .lean();

    products = docs.map((p) => ({
      id: p._id.toString(),
      name: p.name,
      slug: p.slug,
      description: p.description,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      accent: p.accent,
      imageUrl: p.imageUrl,
      category: p.category,
      categoryKey: categoryKeyFor(p),
      stock: p.stock,
      inStock: p.stock > 0,
      featured: p.featured,
    }));

    // Active, published categories only — straight from the category collection.
    categories = await resolveStorefrontCategories(docs);
  } catch (error) {
    // DB down — render an empty, friendly storefront rather than a crash page.
    console.error("Store home load failed:", error);
    loadError = true;
  }

  return (
    <Storefront
      products={products}
      categories={categories}
      initialCategory={findCategoryKeyBySlug(categories, requestedCategory) ?? "all"}
      storeName={storeName}
      currency={currency}
      storePhone={storePhone}
      loadError={loadError}
    />
  );
}
