import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { SyncBoot } from "@/components/layout/sync-boot";


export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNAUTHORIZED";
    if (message === "UNAUTHORIZED") {
      redirect("/login");
    }
    redirect("/login");
  }

  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar user={user} />
      {/* The sidebar is fixed-position; reserve its width so content never
          renders underneath it on large screens (mobile sidebar is off-canvas). */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <Header user={user} />
        <SyncBoot />
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
