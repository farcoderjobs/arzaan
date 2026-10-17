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
    <div className="app-canvas flex min-h-dvh bg-slate-50">
      <Sidebar user={user} />
      {/* The sidebar is fixed-position; reserve its width so content never
          renders underneath it on large screens. `ps-` keeps the offset on
          the correct side in RTL locales. */}
      <div className="flex min-w-0 flex-1 flex-col lg:ps-64">
        <Header user={user} />
        <SyncBoot />
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto w-full min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
