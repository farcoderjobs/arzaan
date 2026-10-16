"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, FormField, Input, Select, Textarea, Checkbox } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error as toastError } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { money } from "@/lib/currency";
import { cn } from "@/utils/classname";

const ACCENT_OPTIONS = [
  { value: "indigo", label: "Indigo" },
  { value: "emerald", label: "Emerald" },
  { value: "rose", label: "Rose" },
  { value: "amber", label: "Amber" },
  { value: "sky", label: "Sky" },
  { value: "violet", label: "Violet" },
  { value: "slate", label: "Slate" },
];

/** Same tint/button palette as the storefront card, for the live preview. */
const ACCENT_PREVIEW: Record<string, { chip: string; art: string; button: string }> = {
  indigo: { chip: "bg-indigo-50 text-indigo-700 ring-indigo-100", art: "from-indigo-100 via-indigo-50 to-white", button: "bg-indigo-600" },
  emerald: { chip: "bg-emerald-50 text-emerald-700 ring-emerald-100", art: "from-emerald-100 via-emerald-50 to-white", button: "bg-emerald-600" },
  rose: { chip: "bg-rose-50 text-rose-700 ring-rose-100", art: "from-rose-100 via-rose-50 to-white", button: "bg-rose-600" },
  amber: { chip: "bg-amber-50 text-amber-700 ring-amber-100", art: "from-amber-100 via-amber-50 to-white", button: "bg-amber-500" },
  sky: { chip: "bg-sky-50 text-sky-700 ring-sky-100", art: "from-sky-100 via-sky-50 to-white", button: "bg-sky-600" },
  violet: { chip: "bg-violet-50 text-violet-700 ring-violet-100", art: "from-violet-100 via-violet-50 to-white", button: "bg-violet-600" },
  slate: { chip: "bg-slate-100 text-slate-700 ring-slate-200", art: "from-slate-100 via-slate-50 to-white", button: "bg-slate-700" },
};

const EMPTY_FORM = {
  name: "",
  description: "",
  price: 0,
  compareAtPrice: 0,
  accent: "indigo",
  imageUrl: "",
  category: "General",
  stock: 0,
  featured: false,
  status: "active" as "active" | "inactive",
};

function emojiFor(category: string, name: string): string {
  const text = `${category} ${name}`.toLowerCase();
  if (/coffee|espresso|cappuccino/.test(text)) return "☕";
  if (/tea|chai/.test(text)) return "🍵";
  if (/water|juice|drink|beverage|soda|cola/.test(text)) return "🥤";
  if (/chocolate|candy|sweet|snack|chip|crisps|biscuit|cookie/.test(text)) return "🍫";
  if (/bread|bakery|cake|pastry/.test(text)) return "🥐";
  if (/fruit|apple|banana|veg|fresh/.test(text)) return "🍎";
  if (/clean|soap|detergent|household|laundry|trash/.test(text)) return "🧼";
  if (/shampoo|cream|personal|hygiene|toothpaste|razor/.test(text)) return "🧴";
  if (/spice|rice|flour|oil|grocery|pantry/.test(text)) return "🥫";
  return "🛍️";
}

export function NewStoreProductClient() {
  const router = useRouter();
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const preview = ACCENT_PREVIEW[form.accent] ?? ACCENT_PREVIEW.indigo;

  const save = async () => {
    const errors: Record<string, string> = {};
    if (form.name.trim().length < 2) errors.name = "Name is required (at least 2 characters)";
    if (form.price < 0) errors.price = "Price cannot be negative";
    if (form.compareAtPrice > 0 && form.compareAtPrice <= form.price) {
      errors.compareAtPrice = "Compare-at price must be higher than the selling price";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/store/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          price: Number(form.price),
          compareAtPrice: Number(form.compareAtPrice),
          stock: Number(form.stock),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFieldErrors((data?.error?.details as Record<string, string>) ?? {});
        toastError("Create failed", apiErrorMessage(data, "Please check the form"));
        return;
      }
      success("Product added", `${form.name} is now on the online store`);
      router.push("/store-products");
    } catch {
      toastError("Error", "Could not save the product");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumbs items={[{ label: "Store Products", href: "/store-products" }, { label: "Add Product" }]} />
      <PageHeader
        title="Add store product"
        description="This product appears on the public online store at / — POS products are never exposed."
        actions={
          <Link
            href="/store-products"
            className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            Back to list
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ---------- Form ---------- */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <FormField label="Name" required error={fieldErrors.name}>
                <Input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Premium Green Tea 250g"
                  autoFocus
                />
              </FormField>
            </div>

            <div className="md:col-span-2">
              <FormField label="Description" hint="Shown under the product on the storefront">
                <Textarea
                  rows={3}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="Short, appealing description…"
                />
              </FormField>
            </div>

            <FormField label="Price" required error={fieldErrors.price}>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={form.price}
                onChange={(e) => set("price", Number(e.target.value) || 0)}
              />
            </FormField>

            <FormField
              label="Compare-at price"
              hint="Original price for a strike-through (0 = none)"
              error={fieldErrors.compareAtPrice}
            >
              <Input
                type="number"
                min={0}
                step="0.01"
                value={form.compareAtPrice}
                onChange={(e) => set("compareAtPrice", Number(e.target.value) || 0)}
              />
            </FormField>

            <FormField label="Category" hint="Free text — used for storefront filters">
              <Input
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                placeholder="e.g. Beverages"
              />
            </FormField>

            <FormField label="Stock" required hint="Units available to online buyers">
              <Input
                type="number"
                min={0}
                step={1}
                value={form.stock}
                onChange={(e) => set("stock", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </FormField>

            <FormField label="Card accent">
              <Select value={form.accent} onChange={(v) => set("accent", v)} options={ACCENT_OPTIONS} />
            </FormField>

            <FormField label="Image URL" hint="Optional — a colored card with an emoji is used when empty">
              <Input value={form.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} placeholder="https://…" />
            </FormField>

            <div className="flex flex-wrap items-center gap-6 md:col-span-2">
              <Checkbox
                checked={form.featured}
                onChange={(e) => set("featured", e.target.checked)}
                label="Featured (shown first with a ⭐ badge)"
              />
              <Select
                value={form.status}
                onChange={(v) => set("status", v as "active" | "inactive")}
                options={[
                  { value: "active", label: "Active — visible on store" },
                  { value: "inactive", label: "Inactive — hidden from store" },
                ]}
                className="w-64"
              />
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3 border-t border-slate-200 pt-5">
            <Button variant="secondary" onClick={() => router.push("/store-products")}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Add product
            </Button>
          </div>
        </div>

        {/* ---------- Live preview ---------- */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Storefront preview</p>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className={cn("relative flex h-36 items-center justify-center bg-gradient-to-br", preview.art)}>
              {form.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-5xl">{emojiFor(form.category, form.name)}</span>
              )}
              {form.featured && (
                <span className="absolute left-3 top-3 rounded-full bg-amber-400 px-2.5 py-0.5 text-[11px] font-bold text-amber-950 shadow-sm">
                  ⭐ Featured
                </span>
              )}
              {form.status === "inactive" && (
                <span className="absolute right-3 top-3 rounded-full bg-slate-700/90 px-2.5 py-0.5 text-[11px] font-bold text-white">
                  Hidden
                </span>
              )}
            </div>
            <div className="p-4">
              <span className={cn("inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1", preview.chip)}>
                {form.category || "General"}
              </span>
              <h3 className="mt-2 text-sm font-bold text-slate-900">{form.name || "Your product name"}</h3>
              {form.description && (
                <p className="mt-1 line-clamp-2 text-xs text-slate-500">{form.description}</p>
              )}
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <p className="text-base font-black text-slate-900">{money(Number(form.price) || 0)}</p>
                  {form.compareAtPrice > form.price && form.compareAtPrice > 0 && (
                    <p className="text-[11px] text-slate-400 line-through">{money(form.compareAtPrice)}</p>
                  )}
                </div>
                <span
                  className={cn(
                    "rounded-xl px-3 py-2 text-xs font-bold text-white shadow-sm",
                    form.status === "inactive" ? "bg-slate-300" : preview.button
                  )}
                >
                  {form.status === "inactive" ? "Hidden" : "Add to cart"}
                </span>
              </div>
              <p className="mt-3 text-[11px] text-slate-400">
                {form.stock > 0 ? `${form.stock} in stock` : "Out of stock"}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Only <span className="font-semibold text-slate-700">Active</span> products are visible to shoppers.
          </p>
        </div>
      </div>
    </div>
  );
}
