import type { Metadata } from "next";
import { connectDB } from "@/lib/mongodb";
import { StoreProduct } from "@/models";
import { getStoreSettings } from "@/lib/settings";
import { Storefront, StoreProductView } from "@/components/store/storefront";

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

export default async function StoreHomePage() {
  let products: StoreProductView[] = [];
  let storeName = "Online Store";
  let currency = "AFN";
  let storePhone = "";

  try {
    await connectDB();
    const settings = await getStoreSettings(null);
    if (settings.storeName) storeName = settings.storeName;
    currency = settings.currency || "AFN";
    storePhone = settings.phone || "";

    const docs = await StoreProduct.find({ status: "active" })
      .sort({ featured: -1, createdAt: -1 })
      .select("name slug description price compareAtPrice accent imageUrl category stock featured")
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
      stock: p.stock,
      inStock: p.stock > 0,
      featured: p.featured,
    }));
  } catch (error) {
    // DB down — render an empty, friendly storefront rather than a crash page.
    console.error("Store home load failed:", error);
  }

  const categories = Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort();

  return <Storefront products={products} categories={categories} storeName={storeName} currency={currency} storePhone={storePhone} />;
}
