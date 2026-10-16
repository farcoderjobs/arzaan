import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { ReturnsClient } from "./returns-client";

export const metadata: Metadata = { title: "Returns" };

export default async function ReturnsPage() {
  const user = await requireSessionUser();
  return (
    <ReturnsClient
      canRefund={user.permissions.includes("sales.refund")}
      canViewSales={user.permissions.includes("sales.view")}
    />
  );
}
