"use client";

import { useState, useEffect } from "react";
import { loginSchema } from "@/validations/auth";
import { login } from "@/app/actions/auth";
import { success } from "@/utils/toast";
import { useRouter } from "next/navigation";
import { cn } from "@/utils/classname";
import { useT } from "@/i18n/client";
import { LanguageSwitcher } from "@/components/ui/language-switcher";

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 px-4 py-12">
      <div className="absolute end-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{t.common.appName}</h1>
          <p className="mt-2 text-slate-500">{t.auth.welcomeSubtitle}</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
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
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-sm transition focus:outline-none focus:ring-2",
                  errors.email ? "border-red-500 focus:ring-red-500" : "border-slate-300 focus:ring-blue-500",
                  "placeholder-slate-400"
                )}
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
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-sm transition focus:outline-none focus:ring-2",
                  errors.password ? "border-red-500 focus:ring-red-500" : "border-slate-300 focus:ring-blue-500",
                  "placeholder-slate-400"
                )}
                placeholder="Enter your password"
                autoComplete="current-password"
              />
              {errors.password && <p className="mt-1 text-sm text-red-600">{errors.password}</p>}
            </div>

            {generalError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {generalError}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? `${t.auth.loggingIn}` : t.auth.signIn}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-400">
            Contact your administrator if you need access.
          </p>
        </div>
      </div>
    </div>
  );
}
