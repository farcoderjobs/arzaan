import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { PERMISSIONS } from "@/lib/permissions";
import { StoreProductsClient } from "./store-products-client";

export const metadata: Metadata = { title: "Store Products" };

export default async function StoreProductsPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes(PERMISSIONS.store.manage)) {
    redirect("/dashboard");
  }

  return <StoreProductsClient />;
}
