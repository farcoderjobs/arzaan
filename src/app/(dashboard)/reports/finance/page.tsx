import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { FinanceReportClient } from "./finance-report-client";

export const metadata: Metadata = { title: "Finance Report" };

export default async function FinanceReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.finance")) redirect("/reports");
  return <FinanceReportClient />;
}
