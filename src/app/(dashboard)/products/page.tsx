import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { ProductsClient } from "./products-client";
import { Product } from "@/models";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage() {
  const user = await requireSessionUser();
  const canCreate = user.permissions.includes("products.create");

  return <ProductsClient user={user} canCreate={canCreate} />;
}
