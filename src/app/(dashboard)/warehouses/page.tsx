import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { WarehousesClient } from "./warehouses-client";

export const metadata: Metadata = { title: "Warehouses" };

export default async function WarehousesPage() {
  const user = await requireSessionUser();
  const allowed = user.permissions.includes("inventory.view") || user.permissions.includes("transfers.view");
  if (!allowed) redirect("/dashboard");
  return <WarehousesClient />;
}
