import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { SuppliersReportClient } from "./suppliers-report-client";

export const metadata: Metadata = { title: "Suppliers Report" };

export default async function SuppliersReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.purchases")) redirect("/reports");
  return <SuppliersReportClient />;
}
