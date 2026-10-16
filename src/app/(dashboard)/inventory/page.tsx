import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { InventoryClient } from "./inventory-client";

export const metadata: Metadata = { title: "Inventory" };

export default async function InventoryPage() {
  const user = await requireSessionUser();
  return <InventoryClient user={user} />;
}
