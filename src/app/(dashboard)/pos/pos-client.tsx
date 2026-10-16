"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Modal, FormField, Input, Select, Textarea } from "@/components/ui";
import { success, error, warning } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";
import { Search, Plus, Minus, Trash, X } from "@/components/ui/icons";
import { useConnectivity } from "@/lib/offline/use-connectivity";
import { setPendingCount } from "@/lib/offline/connectivity";
import { newClientTransactionId, offlineReference } from "@/lib/offline/backoff";
import {
  cacheCatalog,
  countUnsynced,
  enqueueSale,
  findCachedProductByBarcode,
  getCachedCategories,
  getMeta,
  getCachedCustomers,
  getCachedProducts,
  getOfflineSoldQuantities,
  putCategories,
  setMeta,
  upsertCachedCustomers,
  upsertCachedProducts,
} from "@/lib/offline/db";

interface PosClientProps {
  canViewSales: boolean;
  /** Whether the cashier may apply discounts (requires the sales.discount permission). */
  canDiscount: boolean;
  /** Print the receipt automatically as soon as a sale completes. */
  autoPrint: boolean;
  /** Cashier name (shown on receipts). */
  userName: string;
  /** Store info for receipts. */
  storeName: string;
  storeAddress: string;
  storePhone: string;
}

interface PosProduct {
  _id: string;
  name: string;
  sku: string;
  barcode: string;
  sellingPrice: number;
  discountPrice: number;
  taxRate: number;
  currentStock: number;
  categoryId?: { _id: string; name: string } | null;
}

interface CartItem {
  productId: string;
  name: string;
  sku: string;
  unitPrice: number;
  quantity: number;
  unitDiscount: number;
  taxRate: number;
  maxStock: number;
}

interface PosCustomer {
  _id: string;
  name: string;
  phone: string;
  balance: number;
}

interface HeldSale {
  _id: string;
  invoiceNumber: string;
  customerName: string | null;
  itemCount: number;
  total: number;
  heldAt: string;
}

type PaymentMethod = "cash" | "card" | "transfer" | "credit";

interface PaymentLine {
  method: PaymentMethod;
  amount: number;
  reference: string;
}

import { money, currencySymbol } from "@/lib/currency";
import { PrintableReceipt, ReceiptData } from "@/components/receipt";

/** Client-side mirror of the server pricing engine — display only, server recalculates. */
function computeTotals(items: CartItem[], saleDiscount: number, discountType: "amount" | "percent") {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const MAX_DISCOUNT_PERCENT = 100;
  let subtotal = 0;
  let tax = 0;
  let lineDiscountTotal = 0;
  const lines = items.map((item) => {
    const gross = round2(item.unitPrice * item.quantity);
    const discount =
      discountType === "percent"
        ? round2((gross * Math.min(item.unitDiscount, MAX_DISCOUNT_PERCENT)) / 100)
        : round2(Math.min(item.unitDiscount, gross));
    const net = round2(gross - discount);
    const lineTax = round2((net * item.taxRate) / 100);
    subtotal = round2(subtotal + gross);
    tax = round2(tax + lineTax);
    lineDiscountTotal = round2(lineDiscountTotal + discount);
    return { ...item, lineDiscount: discount, lineTax, lineTotal: round2(net + lineTax) };
  });
  // Sale-level discount applies to the post-line-discount base (mirrors
  // computeSaleTotals in src/lib/commerce.ts).
  const effectiveBase = round2(subtotal - lineDiscountTotal);
  const saleDiscountAmount =
    discountType === "percent"
      ? round2((effectiveBase * Math.min(saleDiscount, MAX_DISCOUNT_PERCENT)) / 100)
      : round2(Math.min(saleDiscount, effectiveBase));
  // Stored discount includes line discounts so total === subtotal - discount + tax.
  const discountAmount = round2(saleDiscountAmount + lineDiscountTotal);
  const total = round2(subtotal - discountAmount + tax);
  return { lines, subtotal, discountAmount, tax, total };
}

export function PosClient({
  canViewSales,
  canDiscount,
  autoPrint,
  userName,
  storeName,
  storeAddress,
  storePhone,
}: PosClientProps) {
  const tr = useT();
  // Catalog state
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [categories, setCategories] = useState<Array<{ _id: string; name: string }>>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);

  // Cart state
  const [cart, setCart] = useState<CartItem[]>([]);
  const [saleDiscount, setSaleDiscount] = useState("0");
  const [discountType, setDiscountType] = useState<"amount" | "percent">("amount");
  const [saleNote, setSaleNote] = useState("");
  const [customer, setCustomer] = useState<PosCustomer | null>(null);

  // Customer picker
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<PosCustomer[]>([]);
  const customerSearchRef = useRef<HTMLInputElement>(null);

  // Payment
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [lastSale, setLastSale] = useState<{ invoiceNumber: string; total: number; changeAmount: number; _id: string; offline?: boolean } | null>(null);
  // Printable receipt for the last completed sale (auto-printed when enabled).
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const printedInvoice = useRef<string | null>(null);

  // ---------- Offline state ----------
  const { status: connectionStatus } = useConnectivity();
  const isOffline = connectionStatus === "OFFLINE";
  /** Quantities sold while offline (not yet on the server) — reduce displayed stock. */
  const offlineSold = useRef<Map<string, number>>(new Map());
  const prevConnection = useRef<string | null>(null);

  // Hold / resume
  const [heldModalOpen, setHeldModalOpen] = useState(false);
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);

  const searchRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef("");
  const scannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totals = useMemo(
    () => computeTotals(cart, Number(saleDiscount) || 0, discountType),
    [cart, saleDiscount, discountType]
  );

  const totalPaid = useMemo(() => payments.reduce((s, p) => s + p.amount, 0), [payments]);
  const changeDue = useMemo(
    () => Math.max(0, totalPaid - (payments.some((p) => p.method === "credit") ? 0 : totals.total)),
    [totalPaid, totals.total, payments]
  );

  // ---------- Catalog ----------
  const refreshOfflineSold = useCallback(async () => {
    offlineSold.current = await getOfflineSoldQuantities();
    setPendingCount(await countUnsynced());
  }, []);

  /** Subtracts quantities sold while offline from (cached or live) stock. */
  const withOfflineStock = useCallback(<T extends { _id: string; currentStock: number }>(list: T[]): T[] => {
    if (offlineSold.current.size === 0) return list;
    return list.map((p) => {
      const sold = offlineSold.current.get(p._id);
      return sold ? { ...p, currentStock: Math.max(0, p.currentStock - sold) } : p;
    });
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", perPage: "48" });
      if (search) params.set("search", search);
      if (categoryFilter) params.set("categoryId", categoryFilter);
      const res = await fetch(`/api/pos/products?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const list: PosProduct[] = data.products ?? [];
      setProducts(withOfflineStock(list));
      if (data.categories) {
        setCategories(data.categories);
        void putCategories(data.categories);
      }
      void upsertCachedProducts(list);
    } catch {
      // Backend unreachable — serve the last synced catalog from IndexedDB.
      const cached = await getCachedProducts();
      if (cached.length > 0) {
        setProducts(withOfflineStock(cached as PosProduct[]));
        const cats = await getCachedCategories();
        if (cats.length > 0) setCategories(cats);
      }
      // else: keep whatever is already on screen
    } finally {
      setCatalogLoading(false);
    }
  }, [search, categoryFilter, withOfflineStock]);

  useEffect(() => {
    const t = setTimeout(loadCatalog, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadCatalog]);

  // Keep a complete offline copy of the catalog while online (capped at 500
  // products / 5 pages so the initial cache pass stays cheap).
  const refreshCatalogCache = useCallback(async () => {
    try {
      let page = 1;
      let totalPages = 1;
      do {
        const res = await fetch(`/api/pos/products?page=${page}&perPage=100`);
        if (!res.ok) return;
        const data = await res.json();
        const list: PosProduct[] = data.products ?? [];
        if (page === 1) await cacheCatalog(list, data.categories ?? []);
        else if (list.length > 0) await upsertCachedProducts(list);
        totalPages = Math.min(Number(data.totalPages) || 1, 5);
        page += 1;
      } while (page <= totalPages);
    } catch {
      // offline — the existing cache stays valid
    }
  }, []);

  // On mount: warm the offline cache and load pending offline sales.
  useEffect(() => {
    void refreshCatalogCache();
    void refreshOfflineSold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When connectivity returns, refresh stock (synced sales change it) and the cache.
  useEffect(() => {
    const prev = prevConnection.current;
    prevConnection.current = connectionStatus;
    if (connectionStatus === "ONLINE" && prev !== null && prev !== "ONLINE") {
      void refreshOfflineSold().then(() => loadCatalog());
      void refreshCatalogCache();
    }
  }, [connectionStatus, loadCatalog, refreshCatalogCache, refreshOfflineSold]);

  const effectivePrice = (p: PosProduct) =>
    p.discountPrice > 0 && p.discountPrice < p.sellingPrice ? p.discountPrice : p.sellingPrice;

  // ---------- Cart ----------
  const addToCart = useCallback((product: PosProduct, qty = 1) => {
    if (product.currentStock <= 0) {
      warning("Out of stock", `${product.name} has no stock`);
      return;
    }
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product._id);
      if (existing) {
        if (existing.quantity + qty > product.currentStock) {
          warning("Stock limit", `Only ${product.currentStock} units of ${product.name} available`);
          return prev;
        }
        return prev.map((i) => (i.productId === product._id ? { ...i, quantity: i.quantity + qty } : i));
      }
      return [
        ...prev,
        {
          productId: product._id,
          name: product.name,
          sku: product.sku,
          unitPrice: effectivePrice(product),
          quantity: qty,
          unitDiscount: 0,
          taxRate: product.taxRate ?? 0,
          maxStock: product.currentStock,
        },
      ];
    });
  }, []);

  const updateQuantity = (productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((i) =>
          i.productId === productId
            ? { ...i, quantity: Math.min(Math.max(i.quantity + delta, 0), i.maxStock) }
            : i
        )
        .filter((i) => i.quantity > 0)
    );
  };

  const setItemDiscount = (productId: string, value: string) => {
    const num = Number(value) || 0;
    setCart((prev) => prev.map((i) => (i.productId === productId ? { ...i, unitDiscount: Math.max(0, num) } : i)));
  };

  const removeItem = (productId: string) => setCart((prev) => prev.filter((i) => i.productId !== productId));
  const clearCart = () => {
    setCart([]);
    setSaleDiscount("0");
    setSaleNote("");
    setCustomer(null);
  };

  // ---------- Barcode scanner ----------
  // Scanners type fast and end with Enter. We buffer rapid keystrokes in the
  // search box and treat a fast Enter as a barcode lookup.
  const handleScanEnter = useCallback(async () => {
    const term = search.trim();
    if (!term) return;
    try {
      const res = await fetch(`/api/pos/products?barcode=${encodeURIComponent(term)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.product) {
          addToCart(data.product);
          setSearch("");
          return;
        }
      }
      // No exact barcode hit — fall through to grid search (already live)
    } catch {
      // Backend unreachable — try the cached barcode index before giving up.
      const cached = await findCachedProductByBarcode(term);
      if (cached) {
        addToCart(withOfflineStock([cached])[0]);
        setSearch("");
      }
    }
  }, [search, addToCart, withOfflineStock]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScanEnter();
    }
  };

  // ---------- Customer ----------
  useEffect(() => {
    if (!customerModalOpen) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pos/customers?search=${encodeURIComponent(customerSearch)}`);
        if (res.ok) {
          const data = await res.json();
          setCustomerResults(data.customers ?? []);
          void upsertCachedCustomers(data.customers ?? []);
        }
      } catch {
        // Offline — search the cached customer list locally.
        const term = customerSearch.trim().toLowerCase();
        const cached = await getCachedCustomers();
        setCustomerResults(
          cached.filter((c) => !term || c.name.toLowerCase().includes(term) || c.phone.includes(term))
        );
      }
    }, 200);
    return () => clearTimeout(t);
  }, [customerSearch, customerModalOpen]);

  useEffect(() => {
    if (customerModalOpen) setTimeout(() => customerSearchRef.current?.focus(), 50);
  }, [customerModalOpen]);

  // ---------- Payments ----------
  const openPayment = () => {
    if (cart.length === 0) {
      warning("Cart is empty", "Add products before payment");
      return;
    }
    setPayments([{ method: "cash", amount: totals.total, reference: "" }]);
    setPayModalOpen(true);
  };

  const addPaymentLine = () => {
    const remaining = Math.max(0, totals.total - totalPaid);
    setPayments((prev) => [...prev, { method: "cash", amount: remaining, reference: "" }]);
  };

  const updatePayment = (index: number, patch: Partial<PaymentLine>) => {
    setPayments((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const removePayment = (index: number) => setPayments((prev) => prev.filter((_, i) => i !== index));

  const validateClientPayments = (): string | null => {
    if (payments.length === 0) return "Add at least one payment";
    const hasCredit = payments.some((p) => p.method === "credit");
    const nonCredit = payments.filter((p) => p.method !== "credit").reduce((s, p) => s + p.amount, 0);
    if (hasCredit) {
      if (!customer) return "Credit requires a selected customer";
      const creditAmount = payments.filter((p) => p.method === "credit").reduce((s, p) => s + p.amount, 0);
      // A credit sale creates debt for the customer, so it is allowed regardless of
      // their current outstanding balance — only a customer is required.
      if (creditAmount <= 0) return "Credit amount must be greater than zero";
      if (nonCredit > totals.total + 0.001) return "Payments exceed the total alongside credit";
      if (Math.round((nonCredit + creditAmount) * 100) / 100 < totals.total - 0.001) return "Paid amount does not cover the total";
      return null;
    }
    if (nonCredit < totals.total - 0.001) return "Paid amount does not cover the total";
    return null;
  };

  /**
   * Persists a sale into the IndexedDB sync queue when the backend is
   * unreachable. The client-generated id makes a later server replay safe.
   */
  const completeOfflineSale = async (status: "completed" | "held", clientTransactionId: string) => {
    let deviceId = await getMeta<string>("deviceId");
    if (!deviceId) {
      deviceId = newClientTransactionId();
      await setMeta("deviceId", deviceId);
    }
    const offlineRef = offlineReference();
    await enqueueSale({
      clientTransactionId,
      status: "PENDING",
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
      attempts: 0,
      lastError: null,
      offlineRef,
      total: totals.total,
      itemCount: cart.reduce((s, i) => s + i.quantity, 0),
      syncedInvoiceNumber: null,
      syncedAt: null,
      payload: {
        customerId: customer?._id ?? null,
        items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity, unitDiscount: canDiscount ? i.unitDiscount : 0 })),
        discount: canDiscount ? Number(saleDiscount) || 0 : 0,
        discountType,
        payments: payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
        note: saleNote,
        status,
        deviceId,
      },
    });
    setPendingCount(await countUnsynced());
    if (status === "completed") {
      // Same receipt snapshot as the online path, flagged as offline.
      setReceipt({
        invoiceNumber: offlineRef,
        createdAt: new Date().toISOString(),
        storeName,
        address: storeAddress,
        phone: storePhone,
        cashierName: userName,
        customerName: customer?.name ?? null,
        items: totals.lines.map((l) => ({
          name: l.name,
          sku: l.sku,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.lineDiscount,
          tax: l.lineTax,
          total: l.lineTotal,
        })),
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        tax: totals.tax,
        total: totals.total,
        paidAmount: totals.total,
        changeAmount: changeDue,
        payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
        offline: true,
      });
      setLastSale({ invoiceNumber: offlineRef, total: totals.total, changeAmount: changeDue, _id: clientTransactionId, offline: true });
      setPayModalOpen(false);
      setPayments([]);
      clearCart();
      await refreshOfflineSold();
      void loadCatalog();
      warning(tr.offline.offline, tr.offline.saleQueued);
    } else {
      success(tr.offline.offline, tr.offline.saleQueued);
      clearCart();
    }
  };

  const completeSale = async (status: "completed" | "held" = "completed") => {
    if (cart.length === 0) return;
    if (status === "completed") {
      const err = validateClientPayments();
      if (err) {
        error("Payment error", err);
        return;
      }
    }
    setSubmitting(true);
    // Idempotency key generated for EVERY sale: if this POST's response is
    // lost, the offline queue replay (or a retry) can never double-create it.
    const clientTransactionId = newClientTransactionId();
    // Already offline → don't even attempt the network.
    if (isOffline || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      try {
        await completeOfflineSale(status, clientTransactionId);
      } catch {
        error("Error", "Failed to save the sale offline");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientTransactionId,
          customerId: customer?._id ?? null,
          // A user without sales.discount sends no discounts at all (the server
          // rejects them anyway — never rely on the UI alone).
          items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity, unitDiscount: canDiscount ? i.unitDiscount : 0 })),
          discount: canDiscount ? Number(saleDiscount) || 0 : 0,
          discountType,
          payments: status === "completed" ? payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })) : [],
          note: saleNote,
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Sale failed", apiErrorMessage(data, "Server rejected the sale"));
        return;
      }
      if (status === "completed") {
        // Snapshot the receipt BEFORE the cart is cleared so printing never
        // depends on a second click or an extra network round-trip.
        setReceipt({
          invoiceNumber: data.data.invoiceNumber,
          createdAt: new Date().toISOString(),
          storeName,
          address: storeAddress,
          phone: storePhone,
          cashierName: userName,
          customerName: customer?.name ?? null,
          items: totals.lines.map((l) => ({
            name: l.name,
            sku: l.sku,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.lineDiscount,
            tax: l.lineTax,
            total: l.lineTotal,
          })),
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          tax: totals.tax,
          total: data.data.total,
          paidAmount: data.data.paidAmount ?? totals.total,
          changeAmount: data.data.changeAmount,
          payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
          offline: false,
        });
        setLastSale({
          invoiceNumber: data.data.invoiceNumber,
          total: data.data.total,
          changeAmount: data.data.changeAmount,
          _id: data.data.id,
        });
        setPayModalOpen(false);
        setPayments([]);
        clearCart();
        loadCatalog(); // refresh stock
      } else {
        success("Sale held", `Reference ${data.data.invoiceNumber}`);
        setHeldModalOpen(false);
        clearCart();
      }
    } catch {
      // Network failure mid-request — the sale did NOT get lost: persist it
      // to the offline queue. The shared clientTransactionId makes the later
      // sync replay safe even if the server actually received this POST.
      try {
        await completeOfflineSale(status, clientTransactionId);
      } catch {
        error("Error", "Failed to submit sale");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const holdSale = async () => {
    if (cart.length === 0) return;
    await completeSale("held");
  };

  // ---------- Held sales ----------
  const loadHeld = async () => {
    try {
      const res = await fetch("/api/pos/held-sales");
      if (res.ok) {
        const data = await res.json();
        setHeldSales(data.heldSales ?? []);
      }
    } catch {
      // ignore
    }
  };

  const openHeld = () => {
    loadHeld();
    setHeldModalOpen(true);
  };

  const resumeHeld = async (id: string) => {
    try {
      const res = await fetch("/api/pos/held-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const c = data.data.cart;
      setCart(
        (c.items as Array<{ productId: string; name: string; sku: string; quantity: number; unitDiscount: number }>).map((i) => ({
          productId: i.productId,
          name: i.name,
          sku: i.sku,
          unitPrice: 0, // will be re-priced on the server; display refresh below
          quantity: i.quantity,
          unitDiscount: canDiscount ? (i.unitDiscount ?? 0) : 0,
          taxRate: 0,
          maxStock: 999999,
        }))
      );
      // Re-price from catalog to display accurate numbers
      const ids = (c.items as Array<{ productId: string }>).map((i) => i.productId);
      const catalogRes = await fetch("/api/pos/products?perPage=100");
      if (catalogRes.ok) {
        const catalog = await catalogRes.json();
        const map = new Map<string, PosProduct>((catalog.products as PosProduct[]).map((p) => [p._id, p]));
        setCart(
          (c.items as Array<{ productId: string; quantity: number; unitDiscount: number }>).map((i) => {
            const p = map.get(i.productId);
            return {
              productId: i.productId,
              name: p?.name ?? "Product",
              sku: p?.sku ?? "",
              unitPrice: p ? effectivePrice(p) : 0,
              quantity: i.quantity,
              unitDiscount: canDiscount ? (i.unitDiscount ?? 0) : 0,
              taxRate: p?.taxRate ?? 0,
              maxStock: p?.currentStock ?? 999999,
            };
          })
        );
      }
      setCustomer(c.customerId ? { _id: c.customerId, name: c.customerName ?? "", phone: "", balance: 0 } : null);
      // A cashier without the discount permission resumes the cart with no discounts.
      setSaleDiscount(canDiscount ? String(c.discount ?? 0) : "0");
      setDiscountType(canDiscount ? (c.discountType ?? "amount") : "amount");
      setSaleNote(c.note ?? "");
      setHeldModalOpen(false);
      success("Sale resumed", "Cart restored from held sale");
      void ids;
    } catch {
      error("Error", "Failed to resume held sale");
    }
  };

  // ---------- Keyboard shortcuts ----------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F3") {
        e.preventDefault();
        setCustomerModalOpen(true);
      } else if (e.key === "F4") {
        e.preventDefault();
        if (!payModalOpen) openPayment();
      } else if (e.key === "F7") {
        e.preventDefault();
        holdSale();
      } else if (e.key === "F8") {
        e.preventDefault();
        openHeld();
      } else if (e.key === "F9") {
        e.preventDefault();
        if (payModalOpen && !submitting) completeSale("completed");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payModalOpen, submitting, cart, payments, totals.total]);

  const remainingDue = Math.max(0, Math.round((totals.total - totalPaid) * 100) / 100);

  // Auto-print: completing a sale (button or F9) prints the receipt with no
  // further clicks. Guarded so each invoice prints exactly once.
  useEffect(() => {
    if (!receipt || !autoPrint) return;
    if (printedInvoice.current === receipt.invoiceNumber) return;
    printedInvoice.current = receipt.invoiceNumber;
    // One short paint delay so the print-only receipt is in the DOM.
    setTimeout(() => window.print(), 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, autoPrint]);

  return (
    <div className="flex h-full flex-col gap-4" data-pos>
      {/* Top bar: search + scanner + category filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={`${tr.pos.scanBarcode} (F2)`}
            className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-4 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
        </div>
        <div className="w-48">
          <Select
            value={categoryFilter}
            onChange={setCategoryFilter}
            placeholder={tr.common.all}
            options={categories.map((c) => ({ value: c._id, label: c.name }))}
            className="w-full"
          />
        </div>
        <Button variant="secondary" onClick={openHeld} title="F8">
          {tr.pos.resumeHeld} {heldSales.length > 0 && `(${heldSales.length})`}
        </Button>
      </div>

      {/* Offline banner */}
      {isOffline && (
        <div
          data-offline-banner
          className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          {tr.offline.offlineBanner}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Product grid */}
        <div className="min-w-0 flex-1 overflow-auto">
          {catalogLoading ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-28 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              {tr.common.noData}. {tr.pos.scanBarcode}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {products.map((p) => (
                <button
                  key={p._id}
                  onClick={() => addToCart(p)}
                  disabled={p.currentStock <= 0}
                  className={cn(
                    "flex h-28 flex-col justify-between rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-blue-400 hover:shadow",
                    p.currentStock <= 0 && "opacity-50"
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{p.name}</p>
                    <p className="truncate text-xs text-slate-400">{p.sku}</p>
                  </div>
                  <div className="flex items-end justify-between w-full">
                    <span className="text-sm font-semibold text-blue-700">{money(effectivePrice(p))}</span>
                    <span className={cn("text-xs", p.currentStock <= 0 ? "text-red-500" : "text-slate-400")}>
                      {p.currentStock <= 0 ? tr.dashboard.outOfStock : `${p.currentStock} ${tr.products.stock}`}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Cart panel */}
        <div className="flex w-[380px] shrink-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <p className="font-semibold text-slate-900">{tr.pos.cart} ({cart.length})</p>
            {cart.length > 0 && (
              <button onClick={clearCart} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                <Trash className="h-3.5 w-3.5" /> {tr.common.clear}
              </button>
            )}
          </div>

          {/* Customer row */}
          <button
            onClick={() => { setCustomerSearch(""); setCustomerModalOpen(true); }}
            className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
          >
            <span className={customer ? "font-medium text-slate-900" : "text-slate-400"}>
              {customer ? `${customer.name}${customer.balance > 0 ? ` — ${tr.dashboard.payables}: ${money(customer.balance)}` : ""}` : `${tr.pos.walkIn} (F3)`}
            </span>
            {customer && (
              <span
                onClick={(e) => { e.stopPropagation(); setCustomer(null); }}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            )}
          </button>

          {/* Items */}
          <div className="min-h-0 flex-1 overflow-auto">
            {cart.length === 0 ? (
              <div className="flex h-full items-center justify-center p-4 text-center text-sm text-slate-400">
                {tr.pos.emptyCart}.<br />{tr.pos.emptyCartHint}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {totals.lines.map((line) => (
                  <li key={line.productId} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{line.name}</p>
                        <p className="text-xs text-slate-400">{line.sku} · {money(line.unitPrice)}</p>
                      </div>
                      <button onClick={() => removeItem(line.productId)} className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex items-center rounded-lg border border-slate-200">
                        <button onClick={() => updateQuantity(line.productId, -1)} className="px-2 py-1 text-slate-500 hover:bg-slate-50" aria-label="Decrease">
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="min-w-[2rem] text-center text-sm font-semibold">{line.quantity}</span>
                        <button onClick={() => updateQuantity(line.productId, +1)} className="px-2 py-1 text-slate-500 hover:bg-slate-50 disabled:opacity-40" disabled={line.quantity >= line.maxStock} aria-label="Increase">
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {canDiscount && (
                        <div className="flex items-center gap-1 text-xs text-slate-400">
                          {tr.common.discount}
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.unitDiscount || ""}
                            onChange={(e) => setItemDiscount(line.productId, e.target.value)}
                            placeholder="0"
                            className="w-16 rounded border border-slate-200 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none"
                          />
                          <span className="w-3 text-slate-500">{discountType === "percent" ? "%" : currencySymbol()}</span>
                        </div>
                      )}
                      <span className="ml-auto text-sm font-semibold text-slate-900">{money(line.lineTotal)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Totals */}
          <div className="space-y-1.5 border-t border-slate-200 px-4 py-3 text-sm">
            <div className="flex items-center justify-between text-slate-500">
              <span>{tr.common.subtotal}</span><span>{money(totals.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-slate-500">
              <span>{tr.common.discount}</span>
              {canDiscount ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={saleDiscount}
                    onChange={(e) => setSaleDiscount(e.target.value)}
                    className="w-20 rounded border border-slate-200 px-2 py-1 text-right text-xs focus:border-blue-500 focus:outline-none"
                  />
                  <select
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as "amount" | "percent")}
                    className="rounded border border-slate-200 px-1 py-1 text-xs focus:border-blue-500 focus:outline-none"
                  >
                    <option value="amount">{currencySymbol()}</option>
                    <option value="percent">%</option>
                  </select>
                  <span className="w-16 text-right text-red-500">−{money(totals.discountAmount)}</span>
                </div>
              ) : (
                <span className="w-16 text-right text-slate-400" title={tr.pos.noDiscountPermission}>
                  −{money(0)}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between text-slate-500">
              <span>{tr.common.tax}</span><span>{money(totals.tax)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-lg font-bold text-slate-900">
              <span>{tr.common.total}</span><span>{money(totals.total)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2 border-t border-slate-200 p-3">
            <Button variant="secondary" onClick={holdSale} disabled={cart.length === 0 || submitting} title="F7">
              {tr.pos.holdSale} (F7)
            </Button>
            <Button onClick={openPayment} disabled={cart.length === 0 || submitting} title="F4">
              {tr.pos.payment} (F4)
            </Button>
          </div>
        </div>
      </div>

      {/* Payment modal */}
      <Modal
        open={payModalOpen}
        onClose={() => { setPayModalOpen(false); setPayments([]); }}
        title={tr.pos.payment}
        size="md"
        closeOnOverlayClick={!submitting}
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => { setPayModalOpen(false); setPayments([]); }} disabled={submitting}>{tr.common.cancel}</Button>,
          <Button key="complete" loading={submitting} onClick={() => completeSale("completed")}>
            {tr.pos.completeSale} — {money(totals.total)} (F9)
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>{tr.common.total}</span>
              <span className="text-2xl font-bold text-slate-900">{money(totals.total)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-slate-500">Paid / Remaining</span>
              <span className={remainingDue > 0 ? "font-medium text-amber-600" : "font-medium text-green-600"}>
                {money(totalPaid)} / {money(remainingDue)}
              </span>
            </div>
            {changeDue > 0 && (
              <div className="mt-2 flex items-center justify-between rounded-lg bg-green-50 px-3 py-2 text-sm">
                <span className="font-medium text-green-700">{tr.pos.change}</span>
                <span className="text-xl font-bold text-green-700">{money(changeDue)}</span>
              </div>
            )}
          </div>

          {payments.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3">
              <div className="w-36">
                <FormField label={tr.common.method}>
                  <Select
                    value={p.method}
                    onChange={(v) => updatePayment(i, { method: v as PaymentMethod })}
                    options={[
                      { value: "cash", label: tr.pos.cash },
                      { value: "card", label: tr.pos.card },
                      { value: "transfer", label: tr.pos.transfer },
                      ...(customer ? [{ value: "credit", label: tr.pos.credit }] : []),
                    ]}
                  />
                </FormField>
              </div>
              <div className="w-32">
                <FormField label={tr.common.amount}>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={p.amount || ""}
                    onChange={(e) => updatePayment(i, { amount: Number(e.target.value) || 0 })}
                  />
                </FormField>
              </div>
              <div className="min-w-[120px] flex-1">
                <FormField label={tr.common.reference}>
                  <Input value={p.reference} onChange={(e) => updatePayment(i, { reference: e.target.value })} placeholder="e.g. auth code" />
                </FormField>
              </div>
              {payments.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => removePayment(i)} className="mb-0.5 text-red-500">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={addPaymentLine}><Plus className="mr-1 h-3.5 w-3.5" />{tr.common.add}</Button>
            {customer && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Put any remaining unpaid balance on the customer's account as credit.
                  const remaining = Math.max(0, Math.round((totals.total - payments.filter((p) => p.method !== "credit").reduce((s, p) => s + p.amount, 0)) * 100) / 100);
                  if (remaining > 0) {
                    setPayments((prev) => [...prev.filter((p) => p.method !== "credit"), { method: "credit", amount: remaining, reference: "" }]);
                  }
                }}
              >
                {tr.pos.credit}
              </Button>
            )}
          </div>

          {validateClientPayments() && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{validateClientPayments()}</p>
          )}
        </div>
      </Modal>

      {/* Customer picker */}
      <Modal open={customerModalOpen} onClose={() => setCustomerModalOpen(false)} title={tr.pos.customer} size="sm">
        <Input
          ref={customerSearchRef}
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          placeholder={tr.common.search}
          autoFocus
        />
        <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-auto">
          {customerResults.length === 0 && <li className="py-6 text-center text-sm text-slate-400">{tr.common.noData}</li>}
          {customerResults.map((c) => (
            <li key={c._id}>
              <button
                onClick={() => { setCustomer(c); setCustomerModalOpen(false); }}
                className="flex w-full items-center justify-between px-2 py-2.5 text-left hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">{c.name}</p>
                  <p className="text-xs text-slate-400">{c.phone}</p>
                </div>
                {c.balance > 0 && <span className="text-xs font-medium text-amber-600">owes {money(c.balance)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      {/* Held sales */}
      <Modal open={heldModalOpen} onClose={() => setHeldModalOpen(false)} title={tr.pos.resumeHeld} size="md">
        {heldSales.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">{tr.common.noData}</p>
        ) : (
          <ul className="max-h-80 divide-y divide-slate-100 overflow-auto">
            {heldSales.map((h) => (
              <li key={h._id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-900">{h.customerName ?? "Walk-in"} — {h.itemCount} item(s)</p>
                  <p className="text-xs text-slate-400">
                    Held {h.heldAt ? new Date(h.heldAt).toLocaleTimeString() : ""} · {money(h.total)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => resumeHeld(h._id)}>Resume</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {/* Last sale receipt prompt */}
      <Modal open={lastSale !== null} onClose={() => { setLastSale(null); setReceipt(null); }} title="Sale Completed" size="sm"
        footer={[
          receipt ? (
            <Button key="print" variant="secondary" onClick={() => window.print()}>{tr.sales.printReceipt}</Button>
          ) : null,
          canViewSales && lastSale && !lastSale.offline ? (
            <Link key="view" href={`/sales/${lastSale._id}`}>
              <Button variant="secondary">View Receipt</Button>
            </Link>
          ) : null,
          <Button key="ok" onClick={() => { setLastSale(null); setReceipt(null); }}>New Sale</Button>,
        ]}
      >
        {lastSale && (
          <div className="space-y-2 text-center">
            <p className="text-sm text-slate-500">Invoice</p>
            <p className="font-mono text-lg font-semibold text-slate-900">{lastSale.invoiceNumber}</p>
            <p className="text-sm text-slate-600">Total {money(lastSale.total)}</p>
            {lastSale.offline && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">{tr.offline.saleQueued}</p>
            )}
            {lastSale.changeAmount > 0 && (
              <p className="text-lg font-bold text-green-700">Change due: {money(lastSale.changeAmount)}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Printable receipt (hidden on screen, printed automatically on completion) */}
      {receipt && <PrintableReceipt data={receipt} />}
    </div>
  );
}
