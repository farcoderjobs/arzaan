import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { PurchasesClient } from "./purchases-client";

export const metadata: Metadata = { title: "Purchases" };

export default async function PurchasesPage() {
  const user = await requireSessionUser();
  const canCreate = user.permissions.includes("purchases.create");
  const canCancel = user.permissions.includes("purchases.cancel");
  return <PurchasesClient user={user} canCreate={canCreate} canCancel={canCancel} />;
}
