import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { TransfersClient } from "./transfers-client";

export const metadata: Metadata = { title: "Stock Transfers" };

export default async function TransfersPage() {
  const user = await requireSessionUser();
  return (
    <TransfersClient
      canCreate={user.permissions.includes("transfers.create")}
      canDispatch={user.permissions.includes("transfers.dispatch")}
      canReceive={user.permissions.includes("transfers.receive")}
      canCancel={user.permissions.includes("transfers.cancel")}
    />
  );
}
