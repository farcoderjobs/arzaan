import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { DepartmentReportClient } from "./department-report-client";

export const metadata: Metadata = { title: "Department Report" };

export default async function DepartmentReportPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("reports.departments")) redirect("/reports");
  return <DepartmentReportClient />;
}
