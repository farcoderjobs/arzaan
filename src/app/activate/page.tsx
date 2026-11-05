import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLicenseState } from "@/lib/license";
import { ActivationForm } from "./activation-form";

export const metadata: Metadata = {
  title: "Activate POS",
  description: "Renew this installation's subscription",
};

function formatDate(value: Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(value);
}

export default async function ActivatePage() {
  // `force` so a just-activated licence is never read from the cache here.
  const license = await getLicenseState({ force: true });
  if (!license.blocked) redirect("/login");

  const tampered = license.status === "tampered";

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-lg font-black text-white shadow-lg shadow-orange-600/25">
            !
          </div>
          <div>
            <p className="text-base font-semibold text-slate-900">Activation required</p>
            <p className="text-xs text-slate-500">This installation is not active</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {tampered ? "Licence could not be verified" : "Your subscription has expired"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {tampered
              ? "The stored licence dates do not match their signature, so the app cannot trust them. Enter the activation password to restore a valid licence."
              : "The paid year for this POS has ended. All your data is safe — enter the activation password to start another year and the app will work again immediately."}
          </p>

          <dl className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Installed</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{formatDate(license.installedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Paid until</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{formatDate(license.paidUntil)}</dd>
            </div>
          </dl>

          <ActivationForm />

          <p className="mt-6 text-center text-xs text-slate-400">
            Contact your supplier if you do not have the activation password.
          </p>
        </div>
      </div>
    </div>
  );
}
