import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { InventoryClient } from "./inventory-client";

export const metadata: Metadata = { title: "Inventory" };

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ expiry?: string | string[] }>;
}) {
  const user = await requireSessionUser();
  const params = await searchParams;
  const expiry = Array.isArray(params.expiry) ? params.expiry[0] : params.expiry;
  return <InventoryClient user={user} initialExpiry={expiry ?? ""} />;
}
