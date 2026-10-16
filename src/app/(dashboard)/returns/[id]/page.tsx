import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { ReturnDetailClient } from "./return-detail-client";

export const metadata: Metadata = { title: "Return Details" };

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await params;
  return (
    <ReturnDetailClient
      returnId={id}
      canRefund={user.permissions.includes("sales.refund")}
      canViewSales={user.permissions.includes("sales.view")}
    />
  );
}
