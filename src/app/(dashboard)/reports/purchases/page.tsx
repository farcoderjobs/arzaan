import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { PurchasesReportClient } from "./purchases-report-client";

export const metadata: Metadata = { title: "Purchases Report" };

export default async function PurchasesReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.purchases")) redirect("/reports");
  return <PurchasesReportClient />;
}
