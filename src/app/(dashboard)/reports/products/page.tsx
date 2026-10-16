import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { ProductsReportClient } from "./products-report-client";

export const metadata: Metadata = { title: "Products Report" };

export default async function ProductsReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.products")) redirect("/reports");
  return <ProductsReportClient />;
}
