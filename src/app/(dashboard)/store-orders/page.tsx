import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { PERMISSIONS } from "@/lib/permissions";
import { StoreOrdersClient } from "./store-orders-client";

export const metadata: Metadata = { title: "Store Orders" };

export default async function StoreOrdersPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes(PERMISSIONS.store.orders)) {
    redirect("/dashboard");
  }

  return <StoreOrdersClient />;
}
