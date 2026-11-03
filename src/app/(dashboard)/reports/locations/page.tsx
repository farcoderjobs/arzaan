import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { LocationsReportClient } from "./locations-report-client";

export const metadata: Metadata = { title: "Stock by Location" };

export default async function LocationsReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.inventory")) redirect("/reports");
  return <LocationsReportClient />;
}
