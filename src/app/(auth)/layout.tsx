import { redirect } from "next/navigation";
import { getLicenseState } from "@/lib/license";

/**
 * The (auth) group is the login screen. When the subscription has lapsed there
 * is no point rendering it — the credentials would be refused anyway — so the
 * user goes straight to the renewal screen.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const license = await getLicenseState();
  if (license.blocked) redirect("/activate");

  return <>{children}</>;
}
