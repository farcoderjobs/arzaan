"use client";

import { useEffect, useState } from "react";
import { FormField, Input, Select } from "@/components/ui";

/**
 * Online-store category picker.
 *
 * Category options come from the existing MongoDB category collection (active
 * rows only) so the storefront navigation, category names and product links all
 * stay consistent with the database. When no categories can be loaded (e.g. the
 * user lacks categories.view) it falls back to the legacy free-text field.
 */
export function StoreCategoryField({
  categoryId,
  category,
  onChange,
  error,
}: {
  categoryId: string;
  category: string;
  onChange: (next: { categoryId: string; category: string }) => void;
  error?: string;
}) {
  const [categories, setCategories] = useState<Array<{ _id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/categories");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as Array<{ _id: string; name: string }>;
        if (!cancelled) setCategories(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <FormField label="Category" hint="Loaded from the category collection">
        <div className="h-11 animate-pulse rounded-xl bg-slate-100" />
      </FormField>
    );
  }

  if (failed || categories.length === 0) {
    return (
      <FormField
        label="Category"
        hint="No categories available — free text is used for storefront filters"
        error={error}
      >
        <Input
          value={category}
          onChange={(e) => onChange({ categoryId: "", category: e.target.value })}
          placeholder="e.g. Beverages"
        />
      </FormField>
    );
  }

  return (
    <FormField label="Category" hint="Active categories from the store database" error={error}>
      <Select
        value={categoryId}
        onChange={(value) => {
          const selected = categories.find((c) => c._id === value);
          onChange({ categoryId: value, category: selected?.name ?? "" });
        }}
        options={[
          { value: "", label: "No category (use existing text)" },
          ...categories.map((c) => ({ value: c._id, label: c.name })),
        ]}
      />
    </FormField>
  );
}
