import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { DashboardClient } from "./dashboard-client";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireSessionUser();
  return (
    <DashboardClient
      userName={user.name}
      canSeeProfit={user.permissions.includes("reports.profit")}
      canSeeExpenses={user.permissions.includes("reports.finance") || user.permissions.includes("reports.profit")}
    />
  );
}
