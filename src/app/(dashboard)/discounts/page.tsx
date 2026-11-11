import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { DiscountsClient } from "./discounts-client";

export const metadata: Metadata = { title: "Discounts" };

export default async function DiscountsPage() {
  const user = await requireSessionUser();
  const canManage = user.permissions.includes("discounts.manage");
  return <DiscountsClient canManage={canManage} />;
}
