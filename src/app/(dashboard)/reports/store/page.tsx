import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { PERMISSIONS } from "@/lib/permissions";
import { StoreReportClient } from "./store-report-client";

export const metadata: Metadata = { title: "Online Store Report" };

export default async function StoreReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes(PERMISSIONS.reports.store)) {
    redirect("/reports");
  }

  return <StoreReportClient />;
}
