import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { ProfitReportClient } from "./profit-report-client";

export const metadata: Metadata = { title: "Profit Report" };

export default async function ProfitReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.profit")) redirect("/reports");
  return <ProfitReportClient />;
}
