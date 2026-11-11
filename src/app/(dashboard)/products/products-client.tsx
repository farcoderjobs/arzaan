"use client";

import { useState, useEffect, useCallback } from "react";
import { money } from "@/lib/currency";
import { useRouter, useSearchParams } from "next/navigation";
import { SessionUser } from "@/lib/session";

import { Table, EmptyState } from "@/components/ui/table";
import { SearchInput, Button, Modal, Input, Select, Textarea, FormField } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, Edit, Eye, Toggle } from "@/components/ui/icons";

interface ProductsClientProps {
  user: SessionUser;
  canCreate: boolean;
}

type ProductStatus = "active" | "inactive";

/** Client-side shape of a product row as returned by /api/products. */
type ProductRow = {
  _id: string;
  name: string;
  sku: string;
  barcode?: string;
  barcodes?: Array<{ code: string; label: string }>;
  description?: string;
  categoryId?: string | { _id: string; name: string } | null;
  brandId?: string | { _id: string; name: string } | null;
  departmentId?: string | { _id: string; name: string } | null;
  departmentName?: string;
  purchaseSource?: "import" | "local" | null;

  costPrice?: number;
  sellingPrice?: number;
  discountPrice?: number;
  taxRate?: number;
  discount?: number;
  reorderPoint?: number;
  status?: string;
};

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function ProductsClient({ user, canCreate }: ProductsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [search, setSearch] = useState("");
  const [sku, setSku] = useState("");
  const [status, setStatus] = useState<string>(STATUS_OPTIONS[0].value);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ProductRow | null>(null);
  const [modalMode, setModalMode] = useState<"create" | "edit" | "view" | null>(null);
  const [form, setForm] = useState({
    name: "",
    sku: "",
    barcode: "",
    categoryId: "",
    brandId: "",
    departmentId: "",
    purchaseSource: "" as "" | "import" | "local",
    purchasePrice: "",
    sellingPrice: "",
    wholesalePrice: "",
    tax: "",
    discount: "",
    minimumStock: "",
    description: "",
    status: "active" as ProductStatus,
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<ProductRow | null>(null);
  const [toggling, setToggling] = useState(false);
  const [categories, setCategories] = useState<{ _id: string; name: string }[]>([]);
  const [brands, setBrands] = useState<{ _id: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<{ _id: string; name: string }[]>([]);
  const [filterLoading, setFilterLoading] = useState(false);

  // Barcode management (multiple barcodes per product, unique across variants)
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [barcodeProduct, setBarcodeProduct] = useState<ProductRow | null>(null);
  const [barcodeRows, setBarcodeRows] = useState<Array<{ code: string; label: string; primary: boolean }>>([]);
  const [barcodeForm, setBarcodeForm] = useState({ code: "", label: "" });
  const [barcodeEditing, setBarcodeEditing] = useState<string | null>(null);
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const [barcodeError, setBarcodeError] = useState("");

  const loadFilters = useCallback(async () => {
    try {
      const [catRes, brandRes, deptRes] = await Promise.all([
        fetch("/api/categories"),
        fetch("/api/brands"),
        fetch("/api/departments?all=1"),
      ]);
      if (catRes.ok) setCategories(await catRes.json());
      if (brandRes.ok) setBrands(await brandRes.json());
      if (deptRes.ok) {
        const data = await deptRes.json();
        setDepartments(data.departments ?? []);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadProducts = useCallback(async (reloadFilters = false) => {
    if (reloadFilters) await loadFilters();
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(perPage),
        search,
        sku,
        status,
      });
      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Failed to load products");
      const data = await res.json();
      setProducts(data.products ?? []);
      setTotal(data.total ?? 0);
    } catch {
      error("Error", "Failed to load products");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, search, sku, status, loadFilters]);

  useEffect(() => {
    void (async () => {
      await loadProducts(true);
    })();
  }, [loadProducts]);

  useEffect(() => {
    void (async () => {
      await loadFilters();
    })();
// eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setSelected(null);
    setModalMode("create");
    setForm({
      name: "",
      sku: "",
      barcode: "",
      categoryId: "",
      brandId: "",
      departmentId: "",
      purchaseSource: "",
      purchasePrice: "",
      sellingPrice: "",
      wholesalePrice: "",
      tax: "",
      discount: "",
      minimumStock: "",
      description: "",
      status: "active",
    });
    setFormErrors({});
  };

  const openEdit = (product: ProductRow) => {
    setSelected(product);
    setModalMode("edit");
    setForm({
      name: product.name ?? "",
      sku: product.sku ?? "",
      barcode: product.barcode ?? "",
      categoryId: product.categoryId?.toString() ?? "",
      brandId: product.brandId?.toString() ?? "",
      departmentId:
        typeof product.departmentId === "string"
          ? product.departmentId
          : product.departmentId?._id ?? "",
      purchaseSource: product.purchaseSource ?? "",
      purchasePrice: product.costPrice?.toString() ?? "",
      sellingPrice: product.sellingPrice?.toString() ?? "",
      wholesalePrice: product.discountPrice?.toString() ?? "",
      tax: product.taxRate?.toString() ?? "",
      discount: product.discount?.toString() ?? "",
      minimumStock: product.reorderPoint?.toString() ?? "",
      description: product.description ?? "",
      status: (product.status ?? "active") as ProductStatus,
    });
    setFormErrors({});
  };

  const openView = (product: ProductRow) => {
    setSelected(product);
    setModalMode("view");
  };

  const validateForm = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!form.sku.trim()) errs.sku = "SKU is required";
    if (form.purchasePrice && isNaN(Number(form.purchasePrice))) errs.purchasePrice = "Invalid number";
    if (form.sellingPrice && isNaN(Number(form.sellingPrice))) errs.sellingPrice = "Invalid number";
    if (form.tax && (Number(form.tax) < 0 || Number(form.tax) > 100)) errs.tax = "Must be 0–100";
    if (form.discount && (Number(form.discount) < 0 || Number(form.discount) > 100)) errs.discount = "Must be 0–100";
    if (form.minimumStock && (Number(form.minimumStock) < 0 || !Number.isInteger(Number(form.minimumStock)))) {
      errs.minimumStock = "Must be a non-negative integer";
    }
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validateForm()) return;
    setSaving(true);
    try {
      const payload = {
        id: selected?._id?.toString() ?? null,
        name: form.name.trim(),
        sku: form.sku.trim().toUpperCase(),
        barcode: form.barcode.trim().toUpperCase(),
        categoryId: form.categoryId || null,
        brandId: form.brandId || null,
        departmentId: form.departmentId || null,
        purchaseSource: form.purchaseSource || null,
        purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : 0,
        sellingPrice: form.sellingPrice ? Number(form.sellingPrice) : 0,
        wholesalePrice: form.wholesalePrice ? Number(form.wholesalePrice) : 0,
        tax: form.tax ? Number(form.tax) : 0,
        discount: form.discount ? Number(form.discount) : 0,
        minimumStock: form.minimumStock ? Number(form.minimumStock) : 0,
        description: form.description.trim(),
        status: form.status,
      };
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save product"));
        return;
      }
      success("Success", selected ? "Product updated" : "Product created");
      setModalMode(null);
      setSelected(null);
      loadProducts();
    } catch {
      error("Error", "Failed to save product");
    } finally {
      setSaving(false);
    }
  };

  /** Reversible status toggle via PATCH — deactivating never loses the product. */
  const applyToggle = async (product: ProductRow, status: "active" | "inactive"): Promise<boolean> => {
    try {
      const res = await fetch("/api/products", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product._id.toString(), status }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to update product status"));
        return false;
      }
      success("Success", status === "active" ? "Product activated" : "Product deactivated");
      loadProducts();
      return true;
    } catch {
      error("Error", "Failed to update product status");
      return false;
    }
  };

  /** Active → ask, then deactivate. Anything else (inactive/archived) → reactivate. */
  const requestToggle = async (product: ProductRow) => {
    if (product.status === "active") {
      setToggleTarget(product);
      return;
    }
    setToggling(true);
    try {
      await applyToggle(product, "active");
    } finally {
      setToggling(false);
    }
  };

  const handleToggleConfirm = async () => {
    if (!toggleTarget) return;
    setToggling(true);
    try {
      const done = await applyToggle(toggleTarget, "inactive");
      if (done) setToggleTarget(null);
    } finally {
      setToggling(false);
    }
  };

  // ---------- Barcodes ----------
  const loadBarcodes = useCallback(async (productId: string) => {
    try {
      const res = await fetch(`/api/products/barcodes?productId=${productId}`);
      if (!res.ok) return;
      const data = await res.json();
      setBarcodeRows(
        ((data.barcodes ?? []) as Array<{ code: string; label: string; primary: boolean }>).map((b) => ({
          code: b.code,
          label: b.label ?? "",
          primary: Boolean(b.primary),
        }))
      );
    } catch {
      // ignore — the modal simply shows what was loaded before
    }
  }, []);

  const openBarcodes = async (product: ProductRow) => {
    setBarcodeProduct(product);
    setBarcodeForm({ code: "", label: "" });
    setBarcodeEditing(null);
    setBarcodeError("");
    setBarcodeModalOpen(true);
    await loadBarcodes(product._id);
  };

  const submitBarcode = async (
    action: "add" | "update" | "remove" | "generate",
    override?: { code?: string; label?: string }
  ) => {
    if (!barcodeProduct) return;
    setBarcodeBusy(true);
    setBarcodeError("");
    try {
      const code = (override?.code ?? barcodeForm.code).trim();
      const label = (override?.label ?? barcodeForm.label).trim();
      const payload: Record<string, unknown> = {
        action,
        productId: barcodeProduct._id,
        code: action === "generate" ? undefined : code,
        label,
      };
      if (action === "update" && barcodeEditing) payload.oldCode = barcodeEditing;
      const res = await fetch("/api/products/barcodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setBarcodeError(apiErrorMessage(data, "Could not update barcodes"));
        return;
      }
      success("Barcodes", data.message ?? "Saved");
      setBarcodeForm({ code: "", label: "" });
      setBarcodeEditing(null);
      await loadBarcodes(barcodeProduct._id);
      loadProducts();
    } catch {
      setBarcodeError("Could not update barcodes");
    } finally {
      setBarcodeBusy(false);
    }
  };

  const statusBadge = (status: string) => {
    if (status === "active") {
      return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Active</span>;
    }
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Inactive</span>;
  };

  const categoryName = (catId?: ProductRow["categoryId"]) => {
    const id = typeof catId === "string" ? catId : catId && typeof catId === "object" ? catId._id?.toString() : undefined;
    return categories.find((c) => c._id === id)?.name ?? "—";
  };

  const brandName = (brandId?: ProductRow["brandId"]) => {
    const id = typeof brandId === "string" ? brandId : brandId && typeof brandId === "object" ? brandId._id?.toString() : undefined;
    return brands.find((b) => b._id === id)?.name ?? "—";
  };

  const columns = [
    {
      key: "name",
      header: "Product",
      render: (row: ProductRow) => (
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-lg">P</div>
          <div>
            <p className="font-medium text-slate-900">{row.name}</p>
            <p className="text-xs text-slate-500">{row.sku}</p>
          </div>
        </div>
      ),
    },
    {
      key: "prices",
      header: "Prices",
      render: (row: ProductRow) => (
        <div className="text-right">
          <p className="font-medium text-slate-900">{money(Number(row.sellingPrice ?? 0))}</p>
          <p className="text-xs text-slate-500">Cost: {money(Number(row.costPrice ?? 0))}</p>
        </div>
      ),
    },
    {
      key: "stock",
      header: "Min Stock",
      render: (row: ProductRow) => (
        <span className="text-sm text-slate-600">{row.reorderPoint ?? 0}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: ProductRow) => statusBadge(row.status ?? "inactive"),
    },
    {
      key: "actions",
      header: "",
      className: "w-20",
      render: (row: ProductRow) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openView(row);
            }}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="View"
          >
            <Eye className="h-4 w-4" />
          </button>
          {canCreate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openEdit(row);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="Edit"
            >
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canCreate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void openBarcodes(row);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="Manage barcodes"
            >
              <span className="text-sm leading-none">🏷️</span>
            </button>
          )}
          {canCreate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void requestToggle(row);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              title={row.status === "active" ? "Deactivate" : "Reactivate"}
            >
              <Toggle className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Products" }]} />
      <PageHeader
        title="Products"
        description="Manage your product catalog"
        actions={
          canCreate ? (
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add Product
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            onSearch={() => setPage(1)}
            placeholder="Search by name, SKU, barcode..."
            className="max-w-sm"
          />
        </div>
        <div className="w-32">
          <Select
            value={sku}
            onChange={(v) => {
              setSku(v);
              setPage(1);
            }}
            options={[
              { value: "", label: "SKU bar..." },
              { value: "sku", label: "By SKU" },
              { value: "barcode", label: "By barcode" },
            ]}
            placeholder="Filter by..."
            className="w-full"
          />
        </div>
        <div className="w-36">
          <Select
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={STATUS_OPTIONS}
            className="w-full"
          />
        </div>
        {(search || sku || status) && (
          <Button variant="ghost" onClick={() => { setSearch(""); setSku(""); setStatus(""); setPage(1); }}>
            Clear filters
          </Button>
        )}
      </div>

      <Table
        columns={columns}
        data={products}
        keyExtractor={(row) => row._id.toString()}
        loading={loading}
        empty={
          <EmptyState
            label="No products found"
            description="Get started by adding your first product."
          />
        }
        onRowClick={(row) => openView(row)}
      />

      {total > perPage && (
        <div className="mt-4 flex justify-center">
          {/* pagination handled by total/pages could be added */}
        </div>
      )}

      <Modal
        open={modalMode !== null}
        onClose={() => {
          setModalMode(null);
          setSelected(null);
          setFormErrors({});
        }}
        title={modalMode === "create" ? "Add Product" : modalMode === "edit" ? "Edit Product" : "Product Details"}
        size="lg"
        footer={
          modalMode === "view"
            ? undefined
            : [
                <Button key="cancel" variant="secondary" onClick={() => setModalMode(null)}>
                  Cancel
                </Button>,
                <Button key="save" loading={saving} onClick={handleSave}>
                  {modalMode === "create" ? "Create Product" : "Save Changes"}
                </Button>,
              ]
        }
      >
        {modalMode === "view" && selected && (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-2xl">P</div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{selected.name}</h3>
                <p className="text-sm text-slate-500">{selected.sku}</p>
                {selected.barcode && <p className="text-sm text-slate-500">Barcode: {selected.barcode}</p>}
                {(selected.barcodes ?? []).length > 0 && (
                  <p className="text-sm text-slate-500">
                    Other barcodes: {(selected.barcodes ?? []).map((b) => b.code).join(", ")}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Pricing</p>
                <div className="mt-2 space-y-1 text-sm">
                  <p className="text-slate-600">Selling price: <span className="font-medium text-slate-900">{money(Number(selected.sellingPrice ?? 0))}</span></p>
                  <p className="text-slate-600">Purchase price: <span className="font-medium text-slate-900">{money(Number(selected.costPrice ?? 0))}</span></p>
                  <p className="text-slate-600">Wholesale price: <span className="font-medium text-slate-900">{money(Number(selected.discountPrice ?? 0))}</span></p>
                  <p className="text-slate-600">Tax: <span className="font-medium text-slate-900">{Number(selected.taxRate ?? 0).toFixed(2)}%</span></p>
                  <p className="text-slate-600">Discount: <span className="font-medium text-slate-900">{Number(selected.discount ?? 0).toFixed(2)}%</span></p>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Classification</p>
                <div className="mt-2 space-y-1 text-sm">
                  <p className="text-slate-600">Category: <span className="font-medium text-slate-900">{categoryName(selected.categoryId)}</span></p>
                  <p className="text-slate-600">Brand: <span className="font-medium text-slate-900">{brandName(selected.brandId)}</span></p>
                  <p className="text-slate-600">Department: <span className="font-medium text-slate-900">{selected.departmentName || "Shop"}</span></p>
                  <p className="text-slate-600">Purchase source: <span className="font-medium text-slate-900">{selected.purchaseSource === "import" ? "Import (China)" : selected.purchaseSource === "local" ? "Local" : "Not set"}</span></p>
                  <p className="text-slate-600">Status: {statusBadge(selected.status ?? "inactive")}</p>
                  <p className="text-slate-600">Min stock: <span className="font-medium text-slate-900">{selected.reorderPoint ?? 0}</span></p>
                </div>
              </div>
            </div>

            {selected.description && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Description</p>
                <p className="mt-1 text-sm text-slate-600">{selected.description}</p>
              </div>
            )}
          </div>
        )}

        {modalMode !== "view" && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Product Name" required error={formErrors.name}>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Product name"
                />
              </FormField>
              <FormField label="SKU" required error={formErrors.sku}>
                <Input
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })}
                  placeholder="SKU"
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Barcode">
                <Input
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value.toUpperCase() })}
                  placeholder="Barcode (optional)"
                />
              </FormField>
              <FormField label="Category" required error={formErrors.categoryId}>
                <Select
                  value={form.categoryId}
                  onChange={(v) => setForm({ ...form, categoryId: v })}
                  options={categories.map((c) => ({ value: c._id, label: c.name }))}
                  placeholder="Select category"
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Purchase Source" hint="Origin of this product's stock; used in reports when a sold batch has none.">
                <Select
                  value={form.purchaseSource}
                  onChange={(v) => setForm({ ...form, purchaseSource: v as "" | "import" | "local" })}
                  options={[
                    { value: "", label: "Not set" },
                    { value: "local", label: "Local" },
                    { value: "import", label: "Import (China)" },
                  ]}
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Brand">
                <Select
                  value={form.brandId}
                  onChange={(v) => setForm({ ...form, brandId: v })}
                  options={brands.map((b) => ({ value: b._id, label: b.name }))}
                  placeholder="Select brand"
                />
              </FormField>
              <FormField label="Department" hint="Sales of this product are reported under this department.">
                <Select
                  value={form.departmentId}
                  onChange={(v) => setForm({ ...form, departmentId: v })}
                  options={departments.map((d) => ({ value: d._id, label: d.name }))}
                  placeholder="Shop (no department)"
                />
              </FormField>
              <FormField label="Minimum Stock">
                <Input
                  type="number"
                  value={form.minimumStock}
                  onChange={(e) => setForm({ ...form, minimumStock: e.target.value })}
                  placeholder="0"
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Purchase Price" error={formErrors.purchasePrice}>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.purchasePrice}
                  onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
                  placeholder="0.00"
                />
              </FormField>
              <FormField label="Selling Price" required error={formErrors.sellingPrice}>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.sellingPrice}
                  onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })}
                  placeholder="0.00"
                />
              </FormField>
              <FormField label="Wholesale Price">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.wholesalePrice}
                  onChange={(e) => setForm({ ...form, wholesalePrice: e.target.value })}
                  placeholder="0.00"
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Tax (%)">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.tax}
                  onChange={(e) => setForm({ ...form, tax: e.target.value })}
                  placeholder="0"
                />
              </FormField>
              <FormField label="Discount (%)">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.discount}
                  onChange={(e) => setForm({ ...form, discount: e.target.value })}
                  placeholder="0"
                />
              </FormField>
            </div>

            <FormField label="Description">
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Product description (optional)"
                rows={3}
              />
            </FormField>

            <FormField label="Status">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v as ProductStatus })}
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
            </FormField>
          </div>
        )}
      </Modal>

      {/* Barcodes — multiple unique codes per product/variant */}
      <Modal
        open={barcodeModalOpen}
        onClose={() => setBarcodeModalOpen(false)}
        title={`Barcodes — ${barcodeProduct?.name ?? ""}`}
        size="md"
        footer={<Button variant="secondary" onClick={() => setBarcodeModalOpen(false)}>Close</Button>}
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Each barcode identifies one sellable product or variant and must be unique across the whole catalog.
            Generated codes are internal labels — they are not GS1 registrations.
          </p>

          {barcodeRows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
              This product has no barcode yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {barcodeRows.map((row) => (
                <li key={row.code} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-slate-900">{row.code}</p>
                    <p className="text-xs text-slate-400">
                      {row.label || "No label"}{row.primary ? " · Primary" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setBarcodeEditing(row.code);
                        setBarcodeForm({ code: row.code, label: row.label });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-500"
                      loading={barcodeBusy}
                      onClick={() => void submitBarcode("remove", { code: row.code, label: row.label })}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={barcodeEditing ? "Edit barcode" : "New barcode"}>
              <Input
                value={barcodeForm.code}
                onChange={(e) => setBarcodeForm({ ...barcodeForm, code: e.target.value.toUpperCase() })}
                placeholder="e.g. 2001234567890"
              />
            </FormField>
            <FormField label="Label" hint="Optional hint, e.g. flavour or packaging">
              <Input
                value={barcodeForm.label}
                onChange={(e) => setBarcodeForm({ ...barcodeForm, label: e.target.value })}
                placeholder="e.g. Strawberry"
              />
            </FormField>
          </div>

          {barcodeError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{barcodeError}</p>}

          <div className="flex flex-wrap gap-2">
            <Button
              loading={barcodeBusy}
              disabled={!barcodeForm.code.trim()}
              onClick={() => void submitBarcode(barcodeEditing ? "update" : "add")}
            >
              {barcodeEditing ? "Save barcode" : "Add barcode"}
            </Button>
            {barcodeEditing && (
              <Button
                variant="secondary"
                onClick={() => {
                  setBarcodeEditing(null);
                  setBarcodeForm({ code: "", label: "" });
                }}
              >
                Cancel edit
              </Button>
            )}
            {barcodeRows.length === 0 && (
              <Button variant="secondary" loading={barcodeBusy} onClick={() => void submitBarcode("generate")}>
                Generate barcode
              </Button>
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={handleToggleConfirm}
        title="Deactivate product"
        message={`Are you sure you want to deactivate "${toggleTarget?.name}"? It will no longer appear in active product lists — you can reactivate it any time from this screen.`}
        confirmLabel="Deactivate"
        variant="danger"
        loading={toggling}
      />
    </div>
  );
}
