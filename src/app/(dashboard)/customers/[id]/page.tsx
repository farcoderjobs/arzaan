import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { CustomerDetailClient } from "./customer-detail-client";

export const metadata: Metadata = { title: "Customer Details" };

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await params;
  return (
    <CustomerDetailClient
      customerId={id}
      canPayment={user.permissions.includes("customers.payment")}
      canViewSales={user.permissions.includes("sales.view")}
    />
  );
}
