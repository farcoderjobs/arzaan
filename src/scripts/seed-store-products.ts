import { connectDB, disconnectDB } from "@/lib/mongodb";
import { StoreProduct } from "@/models";

/**
 * Dummy storefront products for the public online store (/).
 * Idempotent: a product is skipped when its slug already exists, so it is
 * safe to run repeatedly (npm run seed:store).
 */

type Seed = {
  name: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  category: string;
  stock: number;
  accent: "indigo" | "emerald" | "rose" | "amber" | "sky" | "violet" | "slate";
  featured?: boolean;
};

const PRODUCTS: Seed[] = [
  {
    name: "Premium Green Tea 250g",
    description: "Loose-leaf green tea with a fresh, clean finish. Brews bright and smooth.",
    price: 320,
    compareAtPrice: 400,
    category: "Tea & Coffee",
    stock: 40,
    accent: "emerald",
    featured: true,
  },
  {
    name: "Arabian Coffee Beans 500g",
    description: "Medium-roast beans with cocoa and cardamom notes. Ground fresh to order.",
    price: 750,
    compareAtPrice: 900,
    category: "Tea & Coffee",
    stock: 25,
    accent: "amber",
    featured: true,
  },
  {
    name: "Cola 500ml — 6 Pack",
    description: "Ice-cold classic cola. Perfect for the family fridge.",
    price: 180,
    compareAtPrice: 220,
    category: "Beverages",
    stock: 60,
    accent: "sky",
  },
  {
    name: "Mineral Water 1.5L",
    description: "Naturally filtered spring water, crisp and pure.",
    price: 45,
    category: "Beverages",
    stock: 120,
    accent: "sky",
  },
  {
    name: "Orange Juice 1L",
    description: "100% squeezed orange juice, no added sugar. Shake before serving.",
    price: 120,
    compareAtPrice: 150,
    category: "Beverages",
    stock: 30,
    accent: "amber",
  },
  {
    name: "Milk Chocolate Bar 100g",
    description: "Smooth milk chocolate with a snap you can hear.",
    price: 90,
    category: "Snacks",
    stock: 80,
    accent: "rose",
  },
  {
    name: "Salted Peanuts 200g",
    description: "Crunchy roasted peanuts with a light sea-salt finish.",
    price: 140,
    category: "Snacks",
    stock: 45,
    accent: "violet",
  },
  {
    name: "Potato Chips 150g",
    description: "Thick-cut chips, lightly salted. Last few bags this week.",
    price: 110,
    compareAtPrice: 130,
    category: "Snacks",
    stock: 3,
    accent: "amber",
    featured: true,
  },
  {
    name: "Dish Soap 500ml",
    description: "Concentrated grease-cutting liquid, gentle on hands.",
    price: 160,
    compareAtPrice: 200,
    category: "Household",
    stock: 50,
    accent: "emerald",
  },
  {
    name: "Laundry Powder 1kg",
    description: "Low-suds formula that lifts stains at 30°C.",
    price: 320,
    category: "Household",
    stock: 20,
    accent: "slate",
  },
  {
    name: "Shampoo 400ml",
    description: "Everyday shampoo for soft, manageable hair.",
    price: 260,
    category: "Personal Care",
    stock: 35,
    accent: "violet",
  },
  {
    name: "Toothpaste 100g",
    description: "Fluoride toothpaste for long-lasting fresh breath.",
    price: 95,
    category: "Personal Care",
    stock: 70,
    accent: "sky",
  },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function main() {
  await connectDB();

  let created = 0;
  let skipped = 0;

  for (const seed of PRODUCTS) {
    const slug = slugify(seed.name);
    const exists = await StoreProduct.exists({ slug });
    if (exists) {
      skipped++;
      continue;
    }
    await StoreProduct.create({
      name: seed.name,
      slug,
      description: seed.description,
      price: seed.price,
      compareAtPrice: seed.compareAtPrice ?? 0,
      accent: seed.accent,
      imageUrl: "",
      category: seed.category,
      stock: seed.stock,
      featured: seed.featured ?? false,
      status: "active",
    });
    created++;
  }

  const total = await StoreProduct.countDocuments({});
  console.log(`Store products: ${created} created, ${skipped} already present (${total} total)`);

  await disconnectDB();
}

main().catch((error) => {
  console.error("Store seed failed:", error);
  process.exit(1);
});
