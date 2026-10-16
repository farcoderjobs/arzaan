import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { InventoryReportClient } from "./inventory-report-client";

export const metadata: Metadata = { title: "Inventory Report" };

export default async function InventoryReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.inventory")) redirect("/reports");
  return <InventoryReportClient />;
}
