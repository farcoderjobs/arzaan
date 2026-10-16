import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { CustomersReportClient } from "./customers-report-client";

export const metadata: Metadata = { title: "Customers Report" };

export default async function CustomersReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.sales")) redirect("/reports");
  return <CustomersReportClient />;
}
