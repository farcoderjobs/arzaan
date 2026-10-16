import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { getStoreSettings } from "@/lib/settings";
import { PosClient } from "./pos-client";

export const metadata: Metadata = { title: "POS" };

export default async function PosPage() {
  const user = await requireSessionUser();
  const settings = await getStoreSettings(user.branchId);
  return (
    <PosClient
      canViewSales={user.permissions.includes("sales.view")}
      canDiscount={user.permissions.includes("sales.discount")}
      autoPrint={settings.autoPrintReceipt}
      userName={user.name}
      storeName={settings.storeName}
      storeAddress={settings.address}
      storePhone={settings.phone}
    />
  );
}
