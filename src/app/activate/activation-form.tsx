"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { activateLicenseAction } from "@/app/actions/license";

export function ActivationForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!password.trim()) {
      setError("Enter the activation password.");
      return;
    }

    setLoading(true);
    try {
      const result = await activateLicenseAction(password);
      if (result.error) {
        setError(result.error);
        return;
      }
      // Licence renewed: the login screen renders again on the fresh state.
      router.push("/login");
      router.refresh();
    } catch {
      setError("An unexpected error occurred. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-5 space-y-4">
      <div>
        <label htmlFor="activation-password" className="mb-1.5 block text-sm font-medium text-slate-700">
          Activation password
        </label>
        <input
          id="activation-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          placeholder="Enter the password from your supplier"
          autoComplete="off"
          autoFocus
        />
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
      >
        {loading && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
        )}
        {loading ? "Activating…" : "Activate"}
      </button>
    </form>
  );
}
