import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { SalesReportClient } from "./sales-report-client";

export const metadata: Metadata = { title: "Sales Report" };

export default async function SalesReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.sales")) redirect("/reports");
  return <SalesReportClient />;
}
