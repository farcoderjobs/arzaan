import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { SaleDetailClient } from "./sale-detail-client";

export const metadata: Metadata = { title: "Sale Details" };

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await params;
  return (
    <SaleDetailClient
      saleId={id}
      canRefund={user.permissions.includes("sales.refund")}
      canSeeCost={user.permissions.includes("reports.profit")}
    />
  );
}
