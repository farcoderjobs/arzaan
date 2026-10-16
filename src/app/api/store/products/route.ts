import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { StoreProduct } from "@/models";

/**
 * GET /api/store/products  (PUBLIC — the ecommerce storefront)
 * Only active, in-catalog products are exposed. Prices come straight from the
 * admin-curated StoreProduct rows (separate from the POS product catalog).
 */
export async function GET() {
  try {
    await connectDB();

    const products = await StoreProduct.find({ status: "active" })
      .sort({ featured: -1, createdAt: -1 })
      .select("name slug description price compareAtPrice accent imageUrl category stock featured")
      .lean();

    const categories = Array.from(
      new Set(products.map((p) => p.category).filter(Boolean))
    ).sort();

    return NextResponse.json({
      products: products.map((p) => ({
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
      })),
      categories,
      total: products.length,
    });
  } catch (error) {
    console.error("GET /api/store/products error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
