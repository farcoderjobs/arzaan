import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { StoreProduct } from "@/models";
import { categoryKeyFor, resolveStorefrontCategories } from "@/lib/store-categories";
import { getLicenseState } from "@/lib/license";

/**
 * GET /api/store/products  (PUBLIC — the ecommerce storefront)
 * Only active, in-catalog products are exposed. Prices come straight from the
 * admin-curated StoreProduct rows (separate from the POS product catalog).
 */
export async function GET() {
  const license = await getLicenseState();
  if (license.blocked) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "LICENSE_EXPIRED", message: "This shop's subscription has expired." },
      },
      { status: 403 }
    );
  }

  try {
    await connectDB();

    const products = await StoreProduct.find({ status: "active" })
      .sort({ featured: -1, createdAt: -1 })
      .select("name slug description price compareAtPrice accent imageUrl category categoryId stock featured")
      .lean();

    // Categories come from the category collection (active, used categories only).
    const categories = await resolveStorefrontCategories(products);

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
        categoryKey: categoryKeyFor(p),
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
