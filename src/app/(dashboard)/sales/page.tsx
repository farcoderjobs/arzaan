import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { SalesClient } from "./sales-client";

export const metadata: Metadata = { title: "Sales" };

export default async function SalesPage() {
  const user = await requireSessionUser();
  return <SalesClient />;
}
