"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { AuthUser } from "@/lib/auth";
import type { PermissionName } from "@/lib/authorization";


interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  hasPermission: (permission: PermissionName) => boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth", { method: "GET" });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user ?? null);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  const hasPermission = useCallback(
    (permission: PermissionName) => {
      if (!user) return false;
      // In a real app, roles ship permissions to the client on login.
      // This is a placeholder that will be wired once role-permission data is exposed.
      return false;
    },
    [user]
  );

  return (
    <AuthContext.Provider value={{ user, loading, hasPermission, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
