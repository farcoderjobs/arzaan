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
      canWholesale={user.permissions.includes("sales.wholesale")}
      canRefund={user.permissions.includes("sales.refund")}
      canOverrideExpired={user.permissions.includes("sales.override_expired")}
      bonusRedemptionEnabled={settings.bonusRedemptionEnabled}
      bonusMaxRedeemPercent={settings.bonusMaxRedeemPercent}
      bonusMinRedeemBalance={settings.bonusMinRedeemBalance}
      canEmployeePurchase={
        user.permissions.includes("employee_purchases.process") &&
        user.permissions.includes("employee_purchases.apply_benefit")
      }
      employeePurchaseEnabled={settings.employeePurchaseEnabled}
      employeeBenefitMode={settings.employeeBenefitMode}
      employeeBenefitPercent={settings.employeeBenefitDefaultPercent}
      employeeBenefitFixedAmount={settings.employeeBenefitFixedAmount}
      employeeBenefitWholesaleAllowed={settings.employeeBenefitWholesaleAllowed}
      employeeCreditAllowed={settings.employeeCreditAllowed}
      employeeDeductionMode={settings.employeeDeductionMode}
      autoPrint={settings.autoPrintReceipt}
      userName={user.name}
      storeName={settings.storeName}
      storeAddress={settings.address}
      storePhone={settings.phone}
      logoUrl={settings.logoUrl}
    />
  );
}
