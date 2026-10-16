import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { PERMISSIONS } from "@/lib/permissions";
import { NewStoreProductClient } from "./new-product-client";

export const metadata: Metadata = { title: "Add Store Product" };

export default async function NewStoreProductPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes(PERMISSIONS.store.manage)) {
    redirect("/store-products");
  }

  return <NewStoreProductClient />;
}
