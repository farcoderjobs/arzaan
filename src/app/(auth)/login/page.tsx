"use client";

import { useState, useEffect } from "react";
import { loginSchema } from "@/validations/auth";
import { login } from "@/app/actions/auth";
import { success } from "@/utils/toast";
import { useRouter } from "next/navigation";
import { cn } from "@/utils/classname";
import { useT } from "@/i18n/client";
import { LanguageSwitcher } from "@/components/ui/language-switcher";
import { Eye, EyeOff } from "@/components/ui/icons";

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setGeneralError(""), 5000);
    return () => clearTimeout(timer);
  }, [generalError]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setGeneralError("");
    setErrors({});

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        fieldErrors[err.path[0] as string] = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    setLoading(true);
    try {
      const result = await login({ email, password });
      if (result.error || !result.user) {
        setGeneralError(result.error ?? t.auth.invalidCredentials);
        return;
      }
      success(t.auth.welcomeBack, `${t.auth.signIn}: ${result.user.name}`);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setGeneralError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  const inputClass = (hasError?: string) =>
    cn(
      "w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:ring-2",
      hasError
        ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
        : "border-slate-300 focus:border-blue-500 focus:ring-blue-500/20"
    );

  return (
    <div className="grid min-h-dvh bg-slate-50 lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel (desktop) */}
      <section className="relative hidden overflow-hidden bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
          aria-hidden="true"
        />
        <div className="pointer-events-none absolute -end-24 top-1/3 h-72 w-72 rounded-full bg-blue-500/30 blur-3xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -start-20 bottom-0 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" aria-hidden="true" />

        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-lg font-black text-white shadow-lg shadow-blue-900/50">
            {t.common.appName.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-base font-semibold text-white">{t.common.appName}</p>
            <p className="text-xs text-blue-200/70">Retail Edition</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-white xl:text-4xl">
            Run your store, not your paperwork.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            Sales, inventory, purchases and reports in one fast, offline-friendly workspace.
          </p>
          <ul className="mt-8 space-y-3.5">
            {[
              { icon: "⚡", title: "Lightning-fast POS", note: "Barcode scanning and keyboard shortcuts built for busy counters." },
              { icon: "📦", title: "Stock that stays honest", note: "Every movement is a ledger entry — no manual stock edits." },
              { icon: "📈", title: "Numbers you can trust", note: "Profit, returns and cash flow reconciled in real time." },
            ].map((item) => (
              <li key={item.title} className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-base ring-1 ring-inset ring-white/10">
                  {item.icon}
                </span>
                <div>
                  <p className="text-sm font-semibold text-white">{item.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{item.note}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-slate-500">Staff access only · Sessions are secured with httpOnly cookies</p>
      </section>

      {/* Form panel */}
      <section className="relative flex flex-1 items-center justify-center px-4 py-12 sm:px-8">
        <div className="absolute end-4 top-4 sm:end-6 sm:top-6">
          <LanguageSwitcher />
        </div>

        <div className="w-full max-w-md">
          <div className="mb-7 text-center lg:text-start">
            <div className="mb-4 flex items-center justify-center gap-3 lg:hidden">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-lg font-black text-white shadow-lg shadow-blue-600/25">
                {t.common.appName.charAt(0).toUpperCase()}
              </div>
              <div className="text-start">
                <p className="text-base font-semibold text-slate-900">{t.common.appName}</p>
                <p className="text-xs text-slate-500">Retail Edition</p>
              </div>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{t.auth.welcomeBack}</h1>
            <p className="mt-1.5 text-sm text-slate-500">{t.auth.welcomeSubtitle}</p>
          </div>

          <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">
                  {t.auth.email}
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass(errors.email)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
                {errors.email && <p className="mt-1 text-sm text-red-600">{errors.email}</p>}
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
                  {t.auth.password}
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={cn(inputClass(errors.password), "pe-11")}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && <p className="mt-1 text-sm text-red-600">{errors.password}</p>}
              </div>

              {generalError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                  {generalError}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
              >
                {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
                {loading ? t.auth.loggingIn : t.auth.signIn}
              </button>
            </form>

            <p className="mt-6 text-center text-xs text-slate-400">
              Contact your administrator if you need access.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
