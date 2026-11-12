"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Modal, FormField, Input, Select, Textarea } from "@/components/ui";
import { success, error, warning } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";
import { Search, Plus, Minus, Trash, X } from "@/components/ui/icons";
import { getDeviceId, newClientTransactionId } from "@/lib/sync/client-ids";
import { useSyncStatus } from "@/lib/sync/use-sync-status";
import { BarcodePrintSheet, BarcodeSvg, LABEL_SIZES, type LabelSize } from "@/components/barcode-label";

interface PosClientProps {
  canViewSales: boolean;
  /** Whether the cashier may apply discounts (requires the sales.discount permission). */
  canDiscount: boolean;
  /** Whether this user may apply wholesale prices (sales.wholesale). */
  canWholesale: boolean;
  /** Whether this user may process refunds/exchanges (sales.refund). */
  canRefund: boolean;
  /** Whether reward-credit redemption is enabled in POS settings. */
  bonusRedemptionEnabled: boolean;
  /** Maximum share of the sale total payable with reward credit. */
  bonusMaxRedeemPercent: number;
  /** Minimum bonus balance before the customer may redeem. */
  bonusMinRedeemBalance: number;
  /** Whether this cashier may process purchases for a staff member. */
  canEmployeePurchase: boolean;
  employeePurchaseEnabled: boolean;
  employeeBenefitMode: "percent" | "fixed";
  employeeBenefitPercent: number;
  employeeBenefitFixedAmount: number;
  employeeBenefitWholesaleAllowed: boolean;
  employeeCreditAllowed: boolean;
  employeeDeductionMode: "payroll" | "immediate";
  /** Whether this user may sell expired stock (sales.override_expired). */
  canOverrideExpired: boolean;
  /** Print the receipt automatically as soon as a sale completes. */
  autoPrint: boolean;
  /** Cashier name (shown on receipts). */
  userName: string;
  /** Store info for receipts. */
  storeName: string;
  storeAddress: string;
  storePhone: string;
  /** Store logo printed on receipts; empty falls back to the bundled logo. */
  logoUrl: string;
}

interface PosProduct {
  _id: string;
  name: string;
  sku: string;
  barcode: string;
  sellingPrice: number;
  /** Persisted wholesale price (products API exposes it as wholesalePrice). */
  discountPrice: number;
  wholesalePrice?: number;
  taxRate: number;
  currentStock: number;
  categoryId?: { _id: string; name: string } | null;
  /** Units on hand already expired (single barcode lookup only). */
  expiredQty?: number;
  /** Units still sellable without an override (single barcode lookup only). */
  sellableQty?: number;
  /** Active discount-offer percentage running today for this product. */
  offerDiscountPercent?: number;
  /** Offer name shown to the cashier next to the discounted line. */
  offerName?: string;
}

interface CartItem {
  productId: string;
  name: string;
  sku: string;
  unitPrice: number;
  /** Both catalog tiers are kept so toggling the mode reprices the cart. */
  retailPrice?: number;
  wholesalePrice?: number;
  pricingMode?: "retail" | "wholesale";
  quantity: number;
  unitDiscount: number;
  /** Automatic offer percent from the catalog (never editable as a cashier discount). */
  offerPercent?: number;
  offerName?: string;
  taxRate: number;
  maxStock: number;
  /** Direct-sale lines never affect stock (bought in the market). */
  itemType?: "inventory" | "direct";
  unitCost?: number;
}

interface PosCustomer {
  _id: string;
  name: string;
  phone: string;
  balance: number;
  wholesaleEligible?: boolean;
  bonusPercent?: number;
  bonusBalance?: number;
}

interface PosEmployee {
  _id: string;
  name: string;
  email?: string;
  departmentName: string;
  benefitPercent: number;
  outstanding: number;
}

interface HeldSale {
  _id: string;
  invoiceNumber: string;
  customerName: string | null;
  itemCount: number;
  total: number;
  heldAt: string;
}

interface ReturnableLine {
  lineId: string;
  productId: string | null;
  itemType: "inventory" | "direct";
  pricingMode: "retail" | "wholesale";
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
  returnedQuantity: number;
  returnableQuantity: number;
  /** Full-line value actually paid, after sale discount and employee benefit. */
  linePaid?: number;
  /** Extra discount deducted from this line (sale discount + employee benefit). */
  discountApplied?: number;
  /** Refund for one returned unit of this line. */
  unitRefund?: number;
}

interface RefundSale {
  _id: string;
  invoiceNumber: string;
  createdAt: string;
  customerId: string | null;
  customerName: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paymentMethod: string | null;
  pricingMode: "retail" | "wholesale";
  bonusEarned: number;
  bonusRedeemed: number;
  items: ReturnableLine[];
}

type PaymentMethod = "cash" | "card" | "transfer" | "credit" | "bonus";

interface PaymentLine {
  method: PaymentMethod;
  amount: number;
  reference: string;
}

import { money, currencySymbol } from "@/lib/currency";
import { REFUND_REASONS, OTHER_REASON } from "@/lib/refund-reasons";
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
    const manualDiscount =
      discountType === "percent"
        ? round2((gross * Math.min(item.unitDiscount, MAX_DISCOUNT_PERCENT)) / 100)
        : round2(Math.min(item.unitDiscount, gross));
    // Active offer percentage resolved by the products API and added on top of
    // any cashier discount, before tax — mirrors computeSaleTotals on the server.
    const offerDiscount = round2(
      (gross * Math.min(Math.max(0, item.offerPercent ?? 0), MAX_DISCOUNT_PERCENT)) / 100
    );
    const discount = round2(Math.min(gross, manualDiscount + offerDiscount));
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

function wholesalePriceOf(p: PosProduct): number {
  return p.wholesalePrice ?? p.discountPrice ?? 0;
}

function priceFor(p: PosProduct, mode: "retail" | "wholesale"): number {
  return mode === "wholesale" ? wholesalePriceOf(p) : p.sellingPrice;
}

export function PosClient({
  canViewSales,
  canDiscount,
  canWholesale,
  canRefund,
  bonusRedemptionEnabled,
  bonusMaxRedeemPercent,
  bonusMinRedeemBalance,
  canEmployeePurchase,
  employeePurchaseEnabled,
  employeeBenefitMode,
  employeeBenefitPercent,
  employeeBenefitFixedAmount,
  employeeBenefitWholesaleAllowed,
  employeeCreditAllowed,
  employeeDeductionMode,
  canOverrideExpired,
  autoPrint,
  userName,
  storeName,
  storeAddress,
  storePhone,
  logoUrl,
}: PosClientProps) {
  const tr = useT();
  // Catalog state
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [categories, setCategories] = useState<Array<{ _id: string; name: string }>>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);

  // Pricing tier — server re-authorises and re-prices every sale.
  const [pricingMode, setPricingMode] = useState<"retail" | "wholesale">("retail");

  // Refund / exchange
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundInvoice, setRefundInvoice] = useState("");
  const [refundLookupLoading, setRefundLookupLoading] = useState(false);
  const [refundError, setRefundError] = useState("");
  const [refundSale, setRefundSale] = useState<RefundSale | null>(null);
  const [refundScan, setRefundScan] = useState("");
  const [refundScanNote, setRefundScanNote] = useState("");
  const [refundLines, setRefundLines] = useState<Record<string, { quantity: string; restock: boolean }>>({});
  const [refundMode, setRefundMode] = useState<"refund" | "exchange">("refund");
  const [refundMethod, setRefundMethod] = useState<"cash" | "card" | "transfer" | "credit">("cash");
  const [refundPayMethod, setRefundPayMethod] = useState<"cash" | "card" | "transfer">("cash");
  // Refund reason is prefilled with the most common case; "other" asks for text.
  const [refundReasonChoice, setRefundReasonChoice] = useState(REFUND_REASONS[0].value);
  const [refundCustomReason, setRefundCustomReason] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  // Direct sale (market purchase resold without inventory)
  const [directOpen, setDirectOpen] = useState(false);
  const [directForm, setDirectForm] = useState({ description: "", quantity: "1", cost: "", price: "", tax: "0" });
  const [directError, setDirectError] = useState("");

  // Barcode labels — search a product, print its label, or generate a code.
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [barcodeSearch, setBarcodeSearch] = useState("");
  const [barcodeResults, setBarcodeResults] = useState<PosProduct[]>([]);
  const [barcodeSelected, setBarcodeSelected] = useState<PosProduct | null>(null);
  const [barcodeCopies, setBarcodeCopies] = useState("1");
  const [barcodeSize, setBarcodeSize] = useState<LabelSize>("38x25");
  const [barcodePrint, setBarcodePrint] = useState<PosProduct | null>(null);
  const [barcodeBusy, setBarcodeBusy] = useState(false);

  useEffect(() => {
    if (!barcodeOpen) return;
    const term = barcodeSearch.trim();
    const timer = setTimeout(() => {
      if (!term) {
        setBarcodeResults([]);
        return;
      }
      void fetch(`/api/pos/products?search=${encodeURIComponent(term)}&perPage=8`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => setBarcodeResults(body?.products ?? []))
        .catch(() => setBarcodeResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [barcodeSearch, barcodeOpen]);

  useEffect(() => {
    if (!barcodePrint) return;
    const timer = setTimeout(() => window.print(), 150);
    return () => clearTimeout(timer);
  }, [barcodePrint]);

  useEffect(() => {
    const clear = () => setBarcodePrint(null);
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  const generateBarcode = async () => {
    if (!barcodeSelected) return;
    setBarcodeBusy(true);
    try {
      const res = await fetch("/api/products/barcodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", productId: barcodeSelected._id }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        error("Barcode", apiErrorMessage(body, "Could not generate a barcode"));
        return;
      }
      const code: string = body?.data?.product?.barcode ?? "";
      if (code) {
        setBarcodeSelected({ ...barcodeSelected, barcode: code });
        setBarcodeResults((rows) => rows.map((p) => (p._id === barcodeSelected._id ? { ...p, barcode: code } : p)));
        success("Barcode generated", code);
      }
    } catch {
      error("Barcode", "Could not generate a barcode");
    } finally {
      setBarcodeBusy(false);
    }
  };

  // Cart state
  const [cart, setCart] = useState<CartItem[]>([]);
  // On phones the cart lives in a bottom sheet instead of a side column.
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [saleDiscount, setSaleDiscount] = useState("0");
  const [discountType, setDiscountType] = useState<"amount" | "percent">("amount");
  const [saleNote, setSaleNote] = useState("");
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  /** Give the customer's earned reward credit for this purchase (once per sale). */
  const [giveBonus, setGiveBonus] = useState(true);

  // Employee purchase (staff buy at the POS; unpaid net is recovered by salary)
  const [employeeMode, setEmployeeMode] = useState(false);
  const [employee, setEmployee] = useState<PosEmployee | null>(null);
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employeeResults, setEmployeeResults] = useState<PosEmployee[]>([]);
  const [employeeBusy, setEmployeeBusy] = useState(false);

  // Customer picker
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<PosCustomer[]>([]);
  const customerSearchRef = useRef<HTMLInputElement>(null);

  // Payment
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [lastSale, setLastSale] = useState<{
    invoiceNumber: string;
    total: number;
    changeAmount: number;
    _id: string;
    /** Saved on this computer but not yet pushed to the online database. */
    awaitingSync?: boolean;
  } | null>(null);
  // Printable receipt for the last completed sale (auto-printed when enabled).
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const printedInvoice = useRef<string | null>(null);

  // ---------- Shop-node sync state ----------
  // Sales are always written to the LOCAL server, which owns this shop's
  // database; the node pushes them to the online database on its own schedule.
  // The POS therefore only needs to know whether that push is currently behind.
  const { status: syncStatus } = useSyncStatus({ pollMs: 30_000 });
  const centerUnreachable = syncStatus ? syncStatus.connectivity.reachable === false : false;
  const pendingSync = syncStatus
    ? syncStatus.counts.pending + syncStatus.counts.sending + syncStatus.counts.failed
    : 0;

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

  /** Employer-funded benefit estimate; the server recalculates it authoritatively. */
  const employeeBenefit = useMemo(() => {
    if (!employeeMode || !employee) return 0;
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const base = totals.lines.reduce((sum, line) => {
      if (!employeeBenefitWholesaleAllowed && line.pricingMode === "wholesale") return sum;
      return sum + Math.max(0, line.unitPrice * line.quantity - line.lineDiscount);
    }, 0);
    const raw =
      employeeBenefitMode === "fixed"
        ? employeeBenefitFixedAmount
        : (base * Math.max(0, employee.benefitPercent || employeeBenefitPercent)) / 100;
    return round2(Math.max(0, Math.min(base, raw)));
  }, [
    employeeMode,
    employee,
    totals,
    employeeBenefitMode,
    employeeBenefitFixedAmount,
    employeeBenefitPercent,
    employeeBenefitWholesaleAllowed,
  ]);

  /** What the customer/employee actually has to pay after the employee benefit. */
  const payableTotal = useMemo(
    () => Math.round((Math.max(0, totals.total - employeeBenefit) + Number.EPSILON) * 100) / 100,
    [totals.total, employeeBenefit]
  );
  const changeDue = useMemo(
    () => Math.max(0, totalPaid - (payments.some((p) => p.method === "credit") ? 0 : payableTotal)),
    [totalPaid, payableTotal, payments]
  );

  // ---------- Catalog ----------
  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", perPage: "48" });
      if (search) params.set("search", search);
      if (categoryFilter) params.set("categoryId", categoryFilter);
      const res = await fetch(`/api/pos/products?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setProducts(data.products ?? []);
      if (data.categories) setCategories(data.categories);
    } catch {
      // The local server is the shop's database — if it does not answer, the
      // grid keeps the last list it had on screen and the error surfaces when a
      // sale is attempted.
    } finally {
      setCatalogLoading(false);
    }
  }, [search, categoryFilter]);

  useEffect(() => {
    const t = setTimeout(loadCatalog, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadCatalog]);

  // Stock in the local database can move without this screen acting (another
  // register, a receiver, a return): re-read it after every queued push.
  const prevPending = useRef<number | null>(null);
  useEffect(() => {
    const previous = prevPending.current;
    prevPending.current = pendingSync;
    if (previous !== null && pendingSync < previous) void loadCatalog();
  }, [pendingSync, loadCatalog]);

  /** Splits the cart into stock-managed products and direct-sale lines. */
  const inventoryLines = cart.filter((i) => i.itemType !== "direct");
  const directLines = cart.filter((i) => i.itemType === "direct");

  /** Toggle the price tier and reprice inventory lines already in the cart. */
  const changePricingMode = (enabled: boolean) => {
    if (enabled && !canWholesale) {
      warning("Not authorised", "You do not have permission to apply wholesale pricing.");
      return;
    }
    if (enabled && customer && !customer.wholesaleEligible) {
      warning("Not eligible", `${customer.name} is not eligible for wholesale pricing.`);
      return;
    }
    const missing = inventoryLines.filter((line) => (line.wholesalePrice ?? 0) <= 0);
    if (enabled && missing.length > 0) {
      warning(
        "No wholesale price",
        `${missing[0].name} has no wholesale price. Remove it or set its wholesale price first.`
      );
      return;
    }
    setPricingMode(enabled ? "wholesale" : "retail");
    setCart((prev) =>
      prev.map((line) => {
        if (line.itemType === "direct") return line;
        const nextPrice = enabled ? line.wholesalePrice ?? 0 : line.retailPrice ?? line.unitPrice;
        return { ...line, unitPrice: nextPrice, pricingMode: enabled ? "wholesale" : "retail" };
      })
    );
  };

  /**
   * Per-item price tier: one line can be sold wholesale while everything else
   * stays retail. The top-bar checkbox still switches the whole cart.
   */
  const toggleLineWholesale = (productId: string, enabled: boolean) => {
    const line = cart.find((i) => i.productId === productId);
    if (!line || line.itemType === "direct") return;
    if (enabled) {
      if (!canWholesale) {
        warning("Not authorised", "You do not have permission to apply wholesale pricing.");
        return;
      }
      if (customer && !customer.wholesaleEligible) {
        warning("Not eligible", `${customer.name} is not eligible for wholesale pricing.`);
        return;
      }
      if ((line.wholesalePrice ?? 0) <= 0) {
        warning("No wholesale price", `${line.name} has no wholesale price configured.`);
        return;
      }
    }
    setCart((prev) =>
      prev.map((i) =>
        i.productId === productId
          ? {
              ...i,
              unitPrice: enabled ? i.wholesalePrice ?? i.unitPrice : i.retailPrice ?? i.unitPrice,
              pricingMode: enabled ? "wholesale" : "retail",
            }
          : i
      )
    );
  };

  const addDirectToCart = () => {
    const description = directForm.description.trim();
    const quantity = Math.floor(Number(directForm.quantity));
    const price = Number(directForm.price);
    const cost = directForm.cost === "" ? 0 : Number(directForm.cost);
    const tax = Number(directForm.tax) || 0;
    if (!description) {
      setDirectError("Enter what was sold");
      return;
    }
    if (!Number.isFinite(quantity) || quantity < 1) {
      setDirectError("Quantity must be at least 1");
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setDirectError("Selling price must be greater than zero");
      return;
    }
    if (!Number.isFinite(cost) || cost < 0) {
      setDirectError("Cost cannot be negative");
      return;
    }
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
      setDirectError("Tax must be between 0 and 100");
      return;
    }
    setCart((prev) => [
      ...prev,
      {
        productId: `direct:${newClientTransactionId()}`,
        name: description,
        sku: "DIRECT",
        unitPrice: price,
        quantity,
        unitDiscount: 0,
        taxRate: tax,
        maxStock: 999999,
        itemType: "direct",
        unitCost: cost,
      },
    ]);
    setDirectForm({ description: "", quantity: "1", cost: "", price: "", tax: "0" });
    setDirectError("");
    setDirectOpen(false);
    setMobileCartOpen(true);
  };

  // ---------- Cart ----------
  const addToCart = useCallback((product: PosProduct, qty = 1) => {
    if (product.currentStock <= 0) {
      warning("Out of stock", `${product.name} has no stock`);
      return;
    }
    if (pricingMode === "wholesale" && wholesalePriceOf(product) <= 0) {
      warning(
        "No wholesale price",
        `${product.name} has no wholesale price configured. Disable wholesale pricing or set its wholesale price.`
      );
      return;
    }
    // Expired stock stays in stock totals, but selling it needs an override.
    if (typeof product.expiredQty === "number" && product.expiredQty > 0) {
      const sellable = product.sellableQty ?? Math.max(0, product.currentStock - product.expiredQty);
      if (sellable <= 0) {
        if (!canOverrideExpired) {
          warning("Expired stock", `${product.name} is expired. A manager override is required to sell it.`);
          return;
        }
        // Authorised override: the sale is allowed, the server re-checks the
        // permission and writes an audit entry for every expired-stock sale.
        warning("Selling expired stock", `${product.name} is expired — this sale will be logged.`);
      }
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
          unitPrice: priceFor(product, pricingMode),
          retailPrice: product.sellingPrice,
          wholesalePrice: wholesalePriceOf(product),
          pricingMode,
          quantity: qty,
          unitDiscount: 0,
          offerPercent: product.offerDiscountPercent ?? 0,
          offerName: product.offerName ?? "",
          taxRate: product.taxRate ?? 0,
          maxStock: product.currentStock,
        },
      ];
    });
  }, [canOverrideExpired, pricingMode]);

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
    setGiveBonus(true);
    setEmployeeMode(false);
    setEmployee(null);
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
      // The local server is unreachable: the grid search already knows what it
      // has, so there is nothing else to try — the sale itself will report it.
    }
  }, [search, addToCart]);

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
        }
      } catch {
        // Unreachable local server — keep the current result list.
      }
    }, 200);
    return () => clearTimeout(t);
  }, [customerSearch, customerModalOpen]);

  useEffect(() => {
    if (customerModalOpen) setTimeout(() => customerSearchRef.current?.focus(), 50);
  }, [customerModalOpen]);

  // ---------- Employee purchase ----------
  useEffect(() => {
    if (!employeeModalOpen) return;
    const t = setTimeout(async () => {
      setEmployeeBusy(true);
      try {
        const res = await fetch(`/api/pos/employees?search=${encodeURIComponent(employeeSearch)}`);
        if (res.ok) {
          const data = await res.json();
          setEmployeeResults(data.employees ?? []);
        }
      } catch {
        // Keep the last list when the local server hiccups.
      } finally {
        setEmployeeBusy(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [employeeSearch, employeeModalOpen]);

  const toggleEmployeeMode = (enabled: boolean) => {
    if (enabled && !canEmployeePurchase) {
      warning("Not authorised", "Your role cannot process employee purchases.");
      return;
    }
    if (enabled && !employeePurchaseEnabled) {
      warning("Disabled", "Employee purchases are disabled in settings.");
      return;
    }
    setEmployeeMode(enabled);
    if (enabled) {
      // An employee purchase is personal: it can never be billed to a customer
      // or earn customer bonus.
      setCustomer(null);
      setGiveBonus(false);
      setEmployeeSearch("");
      setEmployeeModalOpen(true);
    } else {
      setEmployee(null);
    }
  };

  const selectEmployee = (next: PosEmployee) => {
    setEmployee(next);
    setEmployeeModalOpen(false);
  };

  const selectCustomer = (next: PosCustomer) => {
    if (pricingMode === "wholesale" && !next.wholesaleEligible) {
      warning(
        "Retail pricing applied",
        `${next.name} is not eligible for wholesale pricing, so the cart switched back to retail.`
      );
      setPricingMode("retail");
      setCart((prev) =>
        prev.map((line) =>
          line.itemType === "direct"
            ? line
            : { ...line, unitPrice: line.retailPrice ?? line.unitPrice, pricingMode: "retail" }
        )
      );
    }
    setCustomer(next);
    setCustomerModalOpen(false);
  };

  // ---------- Payments ----------
  const openPayment = () => {
    if (cart.length === 0) {
      warning("Cart is empty", "Add products before payment");
      return;
    }
    setPayments([{ method: "cash", amount: payableTotal, reference: "" }]);
    setPayModalOpen(true);
  };

  const addPaymentLine = () => {
    const remaining = Math.max(0, payableTotal - totalPaid);
    setPayments((prev) => [...prev, { method: "cash", amount: remaining, reference: "" }]);
  };

  const updatePayment = (index: number, patch: Partial<PaymentLine>) => {
    setPayments((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const removePayment = (index: number) => setPayments((prev) => prev.filter((_, i) => i !== index));

  /** Applies as much of the customer's available reward credit as allowed. */
  const addBonusPayment = () => {
    if (!customer) {
      warning("Select a customer", "Reward credit can only be redeemed for an identified customer");
      return;
    }
    if (!bonusRedemptionEnabled) {
      warning("Reward credit disabled", "Reward-credit redemption is disabled in settings");
      return;
    }
    const maxBySettings = Math.round(
      ((payableTotal * Math.min(100, Math.max(0, bonusMaxRedeemPercent))) / 100 + Number.EPSILON) * 100
    ) / 100;
    // The till starts with one cash line for the whole bill, so the credit has
    // to be taken out of the tendered cash — measuring it against "what is
    // still unpaid" would always come back as zero.
    const available = Math.round(
      (Math.max(0, Math.min(customer.bonusBalance ?? 0, maxBySettings, payableTotal)) + Number.EPSILON) * 100
    ) / 100;
    if (available <= 0) {
      warning("No reward credit available", "There is nothing left to apply on this sale");
      return;
    }
    const money2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    setPayments((prev) => {
      // Applying it again only moves the difference, so a second click never
      // shrinks the cash twice.
      const oldBonus = money2(prev.filter((p) => p.method === "bonus").reduce((s, p) => s + p.amount, 0));
      let delta = money2(available - oldBonus);
      let tenders = prev.filter((p) => p.method !== "bonus").map((p) => ({ ...p }));
      if (delta > 0) {
        tenders = tenders.map((p) => {
          if (delta <= 0) return p;
          const take = Math.min(p.amount, delta);
          delta = money2(delta - take);
          return { ...p, amount: money2(p.amount - take) };
        });
      } else if (delta < 0) {
        // Less credit than before (cap or balance changed): hand it back as cash.
        const giveBack = money2(-delta);
        if (tenders.length > 0) tenders[0] = { ...tenders[0], amount: money2(tenders[0].amount + giveBack) };
        else tenders = [{ method: "cash", amount: giveBack, reference: "" }];
      }
      return [...tenders.filter((p) => p.amount > 0.001), { method: "bonus", amount: available, reference: "reward" }];
    });
  };

  const validateClientPayments = (): string | null => {
    if (payments.length === 0) return "Add at least one payment";

    if (employeeMode) {
      if (!employee) return "Select the employee this purchase is for";
      if (totalPaid > payableTotal + 0.001) return "Payments exceed the total";
      const unpaid = Math.round((payableTotal - totalPaid) * 100) / 100;
      if (unpaid > 0.001 && (!employeeCreditAllowed || employeeDeductionMode === "immediate")) {
        return "This shop requires employee purchases to be paid in full at the till";
      }
      return null;
    }

    const hasCredit = payments.some((p) => p.method === "credit");
    const nonCredit = payments.filter((p) => p.method !== "credit").reduce((s, p) => s + p.amount, 0);
    const bonusPayments = payments.filter((p) => p.method === "bonus");
    if (bonusPayments.length > 0) {
      if (!customer) return "Reward credit requires a selected customer";
      if (!bonusRedemptionEnabled) return "Reward-credit redemption is disabled";
      const bonusTotal = bonusPayments.reduce((s, p) => s + p.amount, 0);
      if (bonusTotal > (customer.bonusBalance ?? 0) + 0.001) {
        return `Only ${money(customer.bonusBalance ?? 0)} reward credit is available`;
      }
      const maxBonus = (payableTotal * Math.min(100, Math.max(0, bonusMaxRedeemPercent))) / 100;
      if (bonusTotal > maxBonus + 0.001) {
        return `Reward credit cannot cover more than ${bonusMaxRedeemPercent}% of this sale`;
      }
      if (bonusTotal + 0.001 < bonusMinRedeemBalance) {
        return `The minimum bonus balance for redemption is ${money(bonusMinRedeemBalance)}`;
      }
    }
    if (hasCredit) {
      if (!customer) return "Credit requires a selected customer";
      const creditAmount = payments.filter((p) => p.method === "credit").reduce((s, p) => s + p.amount, 0);
      // A credit sale creates debt for the customer, so it is allowed regardless of
      // their current outstanding balance — only a customer is required.
      if (creditAmount <= 0) return "Credit amount must be greater than zero";
      if (nonCredit > payableTotal + 0.001) return "Payments exceed the total alongside credit";
      if (Math.round((nonCredit + creditAmount) * 100) / 100 < payableTotal - 0.001) return "Paid amount does not cover the total";
      return null;
    }
    if (nonCredit < payableTotal - 0.001) return "Paid amount does not cover the total";
    if (nonCredit > payableTotal + 0.001) return "Payments exceed the total";
    return null;
  };

  /**
   * Confirms how a locally saved sale stands with the online database, so the
   * cashier knows whether the receipt is already on the center's books.
   */
  const reportSaveState = () => {
    if (centerUnreachable || pendingSync > 0) {
      warning(tr.offline.offline, tr.offline.saleQueued);
    } else {
      success(tr.pos.saleCompleted, tr.offline.online);
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
    // Idempotency key generated for EVERY sale: if this request's response is
    // lost, resending the same payload can never double-create the sale (the
    // server stores this id and enforces it unique).
    const clientTransactionId = newClientTransactionId();
    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientTransactionId,
          deviceId: getDeviceId(),
          customerId: employeeMode ? null : customer?._id ?? null,
          employeePurchase: employeeMode && employee ? { employeeId: employee._id } : null,
          // A user without sales.discount sends no discounts at all (the server
          // rejects them anyway — never rely on the UI alone).
          items: inventoryLines.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitDiscount: canDiscount ? i.unitDiscount : 0,
            pricingMode: i.pricingMode ?? "retail",
          })),
          directItems: directLines.map((i) => ({
            description: i.name,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            unitCost: i.unitCost ?? 0,
            taxRate: i.taxRate,
          })),
          discount: canDiscount ? Number(saleDiscount) || 0 : 0,
          discountType,
          pricingMode,
          grantBonus: employeeMode ? false : giveBonus,
          // Zero tenders are omitted: an employee purchase may go fully on account.
          payments:
            status === "completed"
              ? payments.filter((p) => p.amount > 0).map((p) => ({ method: p.method, amount: p.amount, reference: p.reference }))
              : [],
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
          logoUrl,
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
            direct: l.itemType === "direct",
            pricingMode: l.pricingMode,
          })),
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          tax: totals.tax,
          total: data.data.total,
          paidAmount: data.data.paidAmount ?? totals.total,
          changeAmount: data.data.changeAmount,
          payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
          pricingMode: data.data.pricingMode ?? pricingMode,
          bonusEarned: data.data.bonusEarned ?? 0,
          bonusRedeemed: data.data.bonusRedeemed ?? 0,
          bonusBalance: data.data.bonusBalance,
          employeePurchase: data.data.employeePurchase ?? null,
          offline: false,
        });
        setLastSale({
          invoiceNumber: data.data.invoiceNumber,
          total: data.data.total,
          changeAmount: data.data.changeAmount,
          _id: data.data.id,
          awaitingSync: centerUnreachable || pendingSync > 0,
        });
        setPayModalOpen(false);
        setPayments([]);
        clearCart();
        loadCatalog(); // refresh stock
        reportSaveState();
      } else {
        success("Sale held", `Reference ${data.data.invoiceNumber}`);
        setHeldModalOpen(false);
        clearCart();
      }
    } catch {
      // The local server is the shop's database: if it does not answer, nothing
      // was saved anywhere. Say so plainly instead of implying success.
      error(
        "Sale not saved",
        "Could not reach the local POS server on this computer. Check that it is running and enter the sale again."
      );
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
      const heldItems = c.items as Array<{ productId: string; quantity: number; unitDiscount: number }>;

      // Re-price from the catalog so the resumed cart shows accurate numbers.
      const catalogRes = await fetch("/api/pos/products?perPage=100");
      const map = catalogRes.ok
        ? new Map<string, PosProduct>(
            (((await catalogRes.json()).products ?? []) as PosProduct[]).map((p) => [p._id, p])
          )
        : new Map<string, PosProduct>();

      const restoredMode: "retail" | "wholesale" =
        c.pricingMode === "wholesale" && canWholesale ? "wholesale" : "retail";
      const restored: CartItem[] = heldItems.map((i) => {
        const p = map.get(i.productId);
        return {
          productId: i.productId,
          name: p?.name ?? "Product",
          sku: p?.sku ?? "",
          unitPrice: p ? priceFor(p, restoredMode) : 0,
          retailPrice: p?.sellingPrice,
          wholesalePrice: p ? wholesalePriceOf(p) : 0,
          pricingMode: restoredMode,
          quantity: i.quantity,
          unitDiscount: canDiscount ? (i.unitDiscount ?? 0) : 0,
          taxRate: p?.taxRate ?? 0,
          maxStock: p?.currentStock ?? 999999,
        };
      });

      // Direct-sale lines are restored too (they never depended on stock).
      const heldDirect = (c.directItems ?? []) as Array<{
        description: string;
        quantity: number;
        unitPrice: number;
        unitCost: number;
        taxRate: number;
      }>;
      for (const d of heldDirect) {
        restored.push({
          productId: `direct:${newClientTransactionId()}`,
          name: d.description,
          sku: "DIRECT",
          unitPrice: d.unitPrice,
          quantity: d.quantity,
          unitDiscount: 0,
          taxRate: d.taxRate,
          maxStock: 999999,
          itemType: "direct",
          unitCost: d.unitCost,
        });
      }

      setCart(restored);
      setPricingMode(restoredMode);
      setCustomer(c.customerId ? { _id: c.customerId, name: c.customerName ?? "", phone: "", balance: 0 } : null);
      // A cashier without the discount permission resumes the cart with no discounts.
      setSaleDiscount(canDiscount ? String(c.discount ?? 0) : "0");
      setDiscountType(canDiscount ? (c.discountType ?? "amount") : "amount");
      setSaleNote(c.note ?? "");
      setHeldModalOpen(false);
      success("Sale resumed", "Cart restored from held sale");
    } catch {
      error("Error", "Failed to resume held sale");
    }
  };

  // ---------- Refund / exchange ----------
  const refundSelection = useMemo(() => {
    if (!refundSale) return { items: [] as Array<{ lineId: string; quantity: number; restock: boolean }>, total: 0 };
    const items: Array<{ lineId: string; quantity: number; restock: boolean }> = [];
    let total = 0;
    for (const line of refundSale.items) {
      const entry = refundLines[line.lineId];
      const qty = Math.floor(Number(entry?.quantity ?? 0));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const safe = Math.min(qty, line.returnableQuantity);
      if (safe <= 0) continue;
      items.push({ lineId: line.lineId, quantity: safe, restock: line.itemType === "inventory" && entry.restock !== false });
      // Refund what was actually paid per unit — the wholesale price, line and
      // sale discounts and any employee benefit are already deducted by the
      // server for this specific product.
      const unitRefund =
        typeof line.unitRefund === "number"
          ? line.unitRefund
          : line.quantity > 0
            ? line.subtotal / line.quantity
            : 0;
      total += unitRefund * safe;
    }
    return { items, total: Math.round((total + Number.EPSILON) * 100) / 100 };
  }, [refundSale, refundLines]);

  const refundReplacementTotal = refundMode === "exchange" ? totals.total : 0;
  const refundNet = Math.round((refundReplacementTotal - refundSelection.total + Number.EPSILON) * 100) / 100;

  function openRefund() {
    setRefundInvoice("");
    setRefundScan("");
    setRefundScanNote("");
    setRefundError("");
    setRefundSale(null);
    setRefundLines({});
    setRefundMode("refund");
    setRefundMethod("cash");
    setRefundPayMethod("cash");
    setRefundReasonChoice(REFUND_REASONS[0].value);
    setRefundCustomReason("");
    setRefundNote("");
    setRefundOpen(true);
  }

  const lookupRefundSale = async () => {
    const invoice = refundInvoice.trim();
    if (!invoice) {
      setRefundError("Enter the original receipt/invoice number");
      return;
    }
    setRefundLookupLoading(true);
    setRefundError("");
    try {
      const res = await fetch(`/api/pos/sales-lookup?invoice=${encodeURIComponent(invoice)}`);
      const data = await res.json();
      if (!res.ok) {
        setRefundSale(null);
        setRefundError(apiErrorMessage(data, "Sale not found"));
        return;
      }
      setRefundSale(data.sale);
      setRefundLines(
        Object.fromEntries(
          (data.sale.items as ReturnableLine[]).map((line) => [line.lineId, { quantity: "", restock: true }])
        )
      );
    } catch {
      setRefundError("Could not look up the sale");
    } finally {
      setRefundLookupLoading(false);
    }
  };

  /**
   * Refund by scanning the product instead of typing a receipt number. The
   * server opens the newest sale that still has a returnable unit and the POS
   * only fills in that line — prices stay the ones the customer paid.
   */
  const scanRefundProduct = async () => {
    const term = refundScan.trim();
    if (!term) {
      setRefundError("Scan a product barcode first");
      return;
    }
    setRefundLookupLoading(true);
    setRefundError("");
    setRefundScanNote("");
    try {
      const res = await fetch(`/api/pos/sales-lookup?barcode=${encodeURIComponent(term)}`);
      const data = await res.json();
      if (!res.ok) {
        setRefundSale(null);
        setRefundError(apiErrorMessage(data, "No returnable sale found for that barcode"));
        return;
      }
      const lines = data.sale.items as ReturnableLine[];
      const next: Record<string, { quantity: string; restock: boolean }> = Object.fromEntries(
        lines.map((line) => [line.lineId, { quantity: "", restock: true }])
      );
      const matched = lines.find((line) => line.lineId === data.matchedLineId);
      if (matched) {
        next[matched.lineId] = {
          quantity: String(Math.min(1, matched.returnableQuantity)),
          restock: true,
        };
      }
      setRefundSale(data.sale);
      setRefundLines(next);
      setRefundScan("");
      setRefundScanNote(
        matched
          ? `${data.matchedProductName ?? matched.name} added from ${data.sale.invoiceNumber} — refund ${money(matched.unitRefund ?? matched.sellingPrice)} per unit`
          : ""
      );
    } catch {
      setRefundError("Could not look up the sale");
    } finally {
      setRefundLookupLoading(false);
    }
  };

  const submitRefundExchange = async () => {
    if (!refundSale) {
      setRefundError("Look up the original sale first");
      return;
    }
    if (refundSelection.items.length === 0) {
      setRefundError("Select at least one item and quantity to return");
      return;
    }
    // The reason is picked from the shared list (prefilled with the default).
    const reason =
      refundReasonChoice === OTHER_REASON
        ? refundCustomReason.trim()
        : REFUND_REASONS.find((r) => r.value === refundReasonChoice)?.label ?? refundReasonChoice;
    if (!reason) {
      setRefundError("A reason is required for every refund");
      return;
    }
    if (refundMode === "exchange" && cart.length === 0) {
      setRefundError("Add the replacement items to the cart first, then complete the exchange");
      return;
    }
    setRefundSubmitting(true);
    setRefundError("");
    try {
      const res = await fetch("/api/pos/exchanges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientTransactionId: newClientTransactionId(),
          saleId: refundSale._id,
          items: refundSelection.items,
          refundMethod,
          reason,
          note: refundNote.trim(),
          replacement:
            refundMode === "exchange"
              ? {
                  items: inventoryLines.map((i) => ({
                    productId: i.productId,
                    quantity: i.quantity,
                    unitDiscount: canDiscount ? i.unitDiscount : 0,
                    pricingMode: i.pricingMode ?? "retail",
                  })),
                  directItems: directLines.map((i) => ({
                    description: i.name,
                    quantity: i.quantity,
                    unitPrice: i.unitPrice,
                    unitCost: i.unitCost ?? 0,
                    taxRate: i.taxRate,
                  })),
                  discount: canDiscount ? Number(saleDiscount) || 0 : 0,
                  discountType,
                  pricingMode,
                }
              : null,
          payments:
            refundMode === "exchange" && refundNet > 0
              ? [{ method: refundPayMethod, amount: refundNet, reference: "exchange difference" }]
              : [],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefundError(apiErrorMessage(data, "Refund failed"));
        return;
      }
      const result = data.data;
      success(
        refundMode === "exchange" ? "Exchange completed" : "Refund processed",
        `${result.returnNumber} — refund ${money(result.refundAmount)}${
          result.replacementTotal > 0 ? `, replacement ${money(result.replacementTotal)}` : ""
        }${result.netAmount > 0 ? `, collected ${money(result.netAmount)}` : result.netAmount < 0 ? `, paid out ${money(-result.netAmount)}` : ""}`
      );
      setRefundOpen(false);
      if (refundMode === "exchange") clearCart();
      await loadCatalog();
    } catch {
      setRefundError("Failed to process the refund");
    } finally {
      setRefundSubmitting(false);
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

  const remainingDue = Math.max(0, Math.round((payableTotal - totalPaid) * 100) / 100);

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
    <div className="flex min-h-0 flex-col gap-3 lg:h-full lg:gap-4" data-pos>
      {/* Top bar: search + scanner + category filter */}
      <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap sm:items-center sm:gap-3">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-0">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={`${tr.pos.scanBarcode} (F2)`}
            className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pe-4 ps-9 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            autoFocus
          />
        </div>
        <div className="min-w-0 flex-1 sm:w-48 sm:flex-none">
          <Select
            value={categoryFilter}
            onChange={setCategoryFilter}
            placeholder={tr.common.all}
            options={categories.map((c) => ({ value: c._id, label: c.name }))}
            className="w-full"
          />
        </div>
        {/* Always visible so the cashier knows the tier exists; it can only be
            switched on with sales.wholesale (the server enforces it too). */}
        <label
          title={
            canWholesale
              ? "Charge the stored wholesale price (the customer must be marked wholesale-eligible)"
              : "Your role cannot apply wholesale prices — ask an administrator for the sales.wholesale permission"
          }
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-700 shadow-sm",
            !canWholesale && "opacity-60"
          )}
        >
          <input
            type="checkbox"
            data-testid="pricing-mode-wholesale"
            checked={pricingMode === "wholesale"}
            disabled={!canWholesale}
            onChange={(e) => changePricingMode(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500/40 disabled:cursor-not-allowed"
          />
          Wholesale
        </label>
        {canRefund && (
          <Button variant="secondary" onClick={openRefund} className="shrink-0" data-testid="open-refund">
            Refund / Exchange
          </Button>
        )}
        <Button variant="secondary" onClick={() => { setDirectError(""); setDirectOpen(true); }} className="shrink-0">
          Direct sale
        </Button>
        <Button
          variant="secondary"
          className="shrink-0"
          data-testid="open-barcode"
          onClick={() => {
            setBarcodeSearch("");
            setBarcodeResults([]);
            setBarcodeSelected(null);
            setBarcodeOpen(true);
          }}
        >
          Barcode
        </Button>
        <Button variant="secondary" onClick={openHeld} title="F8" className="shrink-0">
          {tr.pos.resumeHeld} {heldSales.length > 0 && `(${heldSales.length})`}
        </Button>
      </div>

      {/* The online database is behind — selling continues against the local one. */}
      {centerUnreachable && (
        <div
          data-offline-banner
          className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          {tr.offline.posBanner}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Product grid */}
        <div className="min-w-0 flex-1 pb-24 lg:overflow-y-auto lg:pb-0">
          {catalogLoading ? (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100 sm:h-28" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              {tr.common.noData}. {tr.pos.scanBarcode}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-4">
              {products.map((p) => (
                <button
                  key={p._id}
                  onClick={() => addToCart(p)}
                  disabled={p.currentStock <= 0 || (pricingMode === "wholesale" && wholesalePriceOf(p) <= 0)}
                  className={cn(
                    "flex h-24 flex-col justify-between rounded-xl border border-slate-200 bg-white p-3 text-start shadow-sm transition hover:border-blue-400 hover:shadow-md active:scale-[0.99] sm:h-28",
                    (p.currentStock <= 0 || (pricingMode === "wholesale" && wholesalePriceOf(p) <= 0)) && "opacity-50"
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{p.name}</p>
                    <p className="truncate text-xs text-slate-400">{p.sku}</p>
                  </div>
                  <div className="flex w-full items-end justify-between gap-1">
                    <span className="truncate text-sm font-semibold text-blue-700">
                      {money(priceFor(p, pricingMode))}
                      {(p.offerDiscountPercent ?? 0) > 0 && (
                        <span
                          className="ms-1 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-bold uppercase text-emerald-700"
                          title={p.offerName || "Discount offer"}
                        >
                          -{p.offerDiscountPercent}%
                        </span>
                      )}
                      {pricingMode === "wholesale" && wholesalePriceOf(p) <= 0 && (
                        <span className="ms-1 text-[10px] font-normal text-red-500">no wholesale</span>
                      )}
                    </span>
                    <span className={cn("text-xs", p.currentStock <= 0 ? "text-red-500" : "text-slate-400")}>
                      {p.currentStock <= 0 ? tr.dashboard.outOfStock : `${p.currentStock} ${tr.products.stock}`}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mobile cart backdrop */}
        {mobileCartOpen && (
          <div
            className="fixed inset-0 z-30 bg-slate-950/50 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileCartOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Cart panel — side column on desktop, bottom sheet on phones. */}
        <aside
          className={cn(
            "z-40 flex flex-col border border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-out",
            mobileCartOpen ? "translate-y-0" : "pointer-events-none translate-y-full",
            "fixed inset-x-0 bottom-0 max-h-[90dvh] rounded-t-2xl",
            "lg:pointer-events-auto lg:static lg:max-h-none lg:w-[380px] lg:shrink-0 lg:translate-y-0 lg:rounded-2xl lg:shadow-sm"
          )}
        >
          <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-slate-200 lg:hidden" />
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <p className="font-semibold text-slate-900">{tr.pos.cart} ({cart.length})</p>
            <div className="flex items-center gap-1">
              {cart.length > 0 && (
                <button onClick={clearCart} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-600 transition hover:bg-red-50">
                  <Trash className="h-3.5 w-3.5" /> {tr.common.clear}
                </button>
              )}
              <button
                onClick={() => setMobileCartOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 lg:hidden"
                aria-label="Close cart"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Employee purchase toggle — staff buy with the shop's benefit. */}
          {canEmployeePurchase && employeePurchaseEnabled && (
            <label className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-xs text-slate-600">
              <span>
                Employee purchase
                <span className="block text-[10px] text-slate-400">
                  {employeeMode
                    ? "Employer benefit applies; unpaid net goes on the employee account"
                    : "Charge this sale to a staff member and apply their benefit"}
                </span>
              </span>
              <input
                type="checkbox"
                data-testid="employee-purchase-mode"
                checked={employeeMode}
                onChange={(e) => toggleEmployeeMode(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/40"
              />
            </label>
          )}

          {/* Employee or customer row */}
          {employeeMode ? (
            <button
              onClick={() => { setEmployeeSearch(""); setEmployeeModalOpen(true); }}
              className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
              data-testid="select-employee"
            >
              <span className={employee ? "font-medium text-slate-900" : "text-slate-400"}>
                {employee
                  ? `${employee.name}${employee.departmentName ? ` · ${employee.departmentName}` : ""}${employee.outstanding > 0 ? ` · owed ${money(employee.outstanding)}` : ""}`
                  : "Select employee"}
              </span>
              {employee && (
                <span
                  onClick={(e) => { e.stopPropagation(); setEmployee(null); }}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              )}
            </button>
          ) : (
            <button
              onClick={() => { setCustomerSearch(""); setCustomerModalOpen(true); }}
              className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
            >
              <span className={customer ? "font-medium text-slate-900" : "text-slate-400"}>
                {customer
                  ? `${customer.name}${customer.balance > 0 ? ` — ${tr.dashboard.payables}: ${money(customer.balance)}` : ""}${
                      (customer.bonusBalance ?? 0) > 0 ? ` · bonus ${money(customer.bonusBalance ?? 0)}` : ""
                    }`
                  : `${tr.pos.walkIn} (F3)`}
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
          )}

          {/* Bonus: admin sets the percentage, the cashier decides whether it is
              given on this purchase. It can never be granted twice for one sale. */}
          {!employeeMode && (
          <label
            className={cn(
              "flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-xs",
              customer && (customer.bonusPercent ?? 0) > 0 ? "text-slate-600" : "text-slate-400"
            )}
          >
            <span>
              Give bonus{" "}
              {customer && (customer.bonusPercent ?? 0) > 0 ? (
                <span className="font-semibold text-green-700">{customer.bonusPercent}%</span>
              ) : null}
              <span className="block text-[10px] text-slate-400">
                {!customer
                  ? "Select the customer to give their bonus"
                  : (customer.bonusPercent ?? 0) <= 0
                    ? "No bonus percentage set for this customer"
                    : "Credited once per purchase"}
              </span>
            </span>
            <input
              type="checkbox"
              data-testid="give-bonus"
              checked={giveBonus && Boolean(customer) && (customer?.bonusPercent ?? 0) > 0}
              disabled={!customer || (customer.bonusPercent ?? 0) <= 0}
              onChange={(e) => setGiveBonus(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-green-600 focus:ring-green-500/40 disabled:cursor-not-allowed"
            />
          </label>
          )}

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
                        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900">
                          {line.itemType !== "direct" && (
                            <label
                              title={
                                !canWholesale
                                  ? "Your role cannot apply wholesale prices — ask an administrator for the sales.wholesale permission"
                                  : (line.wholesalePrice ?? 0) <= 0
                                    ? "This product has no wholesale price configured"
                                    : customer && !customer.wholesaleEligible
                                      ? `${customer.name} is not eligible for wholesale pricing`
                                      : "Charge the wholesale price for this item only"
                              }
                              className={cn(
                                "flex shrink-0 cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase transition",
                                line.pricingMode === "wholesale"
                                  ? "border-amber-300 bg-amber-100 text-amber-700"
                                  : "border-slate-200 text-slate-500",
                                (!canWholesale || (line.wholesalePrice ?? 0) <= 0) && "cursor-not-allowed opacity-50"
                              )}
                            >
                              <input
                                type="checkbox"
                                data-testid={`line-wholesale-${line.productId}`}
                                checked={line.pricingMode === "wholesale"}
                                disabled={!canWholesale || (line.wholesalePrice ?? 0) <= 0}
                                onChange={(e) => toggleLineWholesale(line.productId, e.target.checked)}
                                className="h-3.5 w-3.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500/40 disabled:cursor-not-allowed"
                              />
                              WS
                            </label>
                          )}
                          <span className="truncate">{line.name}</span>
                          {line.itemType === "direct" && (
                            <span className="ms-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-700">
                              Direct
                            </span>
                          )}
                          {(line.offerPercent ?? 0) > 0 && (
                            <span
                              className="ms-1 shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700"
                              title={line.offerName || "Discount offer"}
                            >
                              {line.offerPercent}% offer
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400">
                          {line.itemType === "direct" ? "No stock movement" : line.sku} · {money(line.unitPrice)}
                          {line.itemType !== "direct" && (
                            <span
                              className={cn(
                                "ms-1 rounded px-1 py-0.5 text-[10px] font-semibold uppercase",
                                line.pricingMode === "wholesale"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-500"
                              )}
                            >
                              {line.pricingMode === "wholesale" ? "Wholesale" : "Retail"}
                            </span>
                          )}
                        </p>
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
            {pricingMode === "wholesale" && (
              <div className="flex items-center justify-between text-amber-700">
                <span>Pricing mode</span><span className="font-semibold">Wholesale</span>
              </div>
            )}
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
            {employeeMode && (
              <div className="flex items-center justify-between text-indigo-700">
                <span>
                  Employee benefit
                  <span className="ms-1 text-xs text-slate-400">
                    ({employeeBenefitMode === "fixed" ? money(employeeBenefitFixedAmount) : `${employee?.benefitPercent ?? employeeBenefitPercent}%`})
                  </span>
                </span>
                <span>−{money(employeeBenefit)}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-lg font-bold text-slate-900">
              <span>{tr.common.total}</span><span>{money(payableTotal)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2 border-t border-slate-200 p-3 pb-safe lg:pb-3">
            <Button variant="secondary" onClick={holdSale} disabled={cart.length === 0 || submitting} title="F7">
              {tr.pos.holdSale} (F7)
            </Button>
            <Button onClick={() => { setMobileCartOpen(false); openPayment(); }} disabled={cart.length === 0 || submitting} title="F4">
              {tr.pos.payment} (F4)
            </Button>
          </div>
        </aside>
      </div>

      {/* Mobile checkout bar — totals and payment stay one thumb-tap away. */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-3 pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden">
        <div className="flex items-center gap-2 pb-2">
          <button
            type="button"
            onClick={() => setMobileCartOpen(true)}
            className="relative flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 transition active:scale-95"
            aria-label={`${tr.pos.cart} (${cart.length})`}
          >
            <span aria-hidden="true">🛒</span>
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] font-bold text-white">
              {cart.reduce((s, i) => s + i.quantity, 0)}
            </span>
          </button>
          <div className="min-w-0 flex-1 text-end">
            <p className="truncate text-base font-bold leading-tight text-slate-900">{money(payableTotal)}</p>
            <p className="truncate text-[11px] text-slate-500">{tr.pos.cart}</p>
          </div>
          <Button
            onClick={() => { setMobileCartOpen(false); openPayment(); }}
            disabled={cart.length === 0 || submitting}
            className="h-11 shrink-0 px-5"
          >
            {tr.pos.payment} (F4)
          </Button>
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
            {tr.pos.completeSale} — {money(payableTotal)} (F9)
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>{tr.common.total}</span>
              <span className="text-2xl font-bold text-slate-900">{money(payableTotal)}</span>
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
            {employeeMode && remainingDue > 0 && (
              <div className="mt-2 flex items-center justify-between rounded-lg bg-indigo-50 px-3 py-2 text-sm">
                <span className="font-medium text-indigo-700">
                  On employee account
                  <span className="block text-[11px] font-normal text-indigo-500">Recovered from salary at payroll</span>
                </span>
                <span className="text-xl font-bold text-indigo-700">{money(remainingDue)}</span>
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
                      ...(customer && bonusRedemptionEnabled
                        ? [{ value: "bonus", label: "Reward credit" }]
                        : []),
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
            {customer && bonusRedemptionEnabled && (customer.bonusBalance ?? 0) > 0 && (
              <Button variant="secondary" size="sm" onClick={addBonusPayment}>
                Use reward credit ({money(customer.bonusBalance ?? 0)})
              </Button>
            )}
          </div>

          {validateClientPayments() && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{validateClientPayments()}</p>
          )}
        </div>
      </Modal>

      {/* Refund / exchange from the original receipt */}
      <Modal
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        title="Refund / Exchange"
        description="Look up the original receipt, choose the items to return, then settle the net difference."
        size="lg"
        closeOnOverlayClick={!refundSubmitting}
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setRefundOpen(false)} disabled={refundSubmitting}>Cancel</Button>,
          <Button key="submit" loading={refundSubmitting} onClick={submitRefundExchange} disabled={!refundSale} data-testid="refund-submit">
            {refundMode === "exchange" ? "Complete exchange" : "Process refund"}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <FormField
                label="Scan a product barcode"
                hint="Opens the newest returnable sale for that product; the item is added back with the price actually paid"
              >
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    data-testid="refund-barcode"
                    value={refundScan}
                    onChange={(e) => setRefundScan(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void scanRefundProduct();
                      }
                    }}
                    placeholder="Scan barcode or type SKU"
                    className="w-full rounded-lg border border-slate-300 py-2 pe-3 ps-9 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>
              </FormField>
            </div>
            <Button variant="secondary" loading={refundLookupLoading} onClick={scanRefundProduct} data-testid="refund-scan">
              Add scanned item
            </Button>
          </div>
          {refundScanNote && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{refundScanNote}</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <FormField label="Original receipt / invoice number" required>
                <Input
                  data-testid="refund-invoice"
                  value={refundInvoice}
                  onChange={(e) => setRefundInvoice(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void lookupRefundSale(); }}
                  placeholder="INV-..."
                  autoFocus
                />
              </FormField>
            </div>
            <Button variant="secondary" loading={refundLookupLoading} onClick={lookupRefundSale} data-testid="refund-lookup">Find sale</Button>
          </div>

          {refundError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{refundError}</p>}

          {refundSale && (
            <>
              <div className="rounded-xl bg-slate-50 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono font-semibold text-slate-900">{refundSale.invoiceNumber}</p>
                  <p className="text-xs text-slate-500">
                    {new Date(refundSale.createdAt).toLocaleString()} · {refundSale.customerName ?? "Walk-in"} · {
                      refundSale.pricingMode === "wholesale" ? "Wholesale" : "Retail"
                    }
                  </p>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Total {money(refundSale.total)} · Refund credit earned {money(refundSale.bonusEarned)} · Bonus used {money(refundSale.bonusRedeemed)}
                </p>
              </div>

              <div className="max-h-64 overflow-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Item</th>
                      <th className="px-3 py-2 text-right">Sold</th>
                      <th className="px-3 py-2 text-right">Returned</th>
                      <th className="px-3 py-2 text-right">Return qty</th>
                      <th className="px-3 py-2 text-center">Restock</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {refundSale.items.map((line) => (
                      <tr key={line.lineId}>
                        <td className="px-3 py-2">
                          <p className="font-medium text-slate-900">
                            {line.name}
                            {line.itemType === "direct" && (
                              <span className="ms-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-700">Direct</span>
                            )}
                            {line.pricingMode === "wholesale" && (
                              <span className="ms-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700">Wholesale</span>
                            )}
                          </p>
                          <p className="text-xs text-slate-400">{money(line.sellingPrice)} · {line.sku}</p>
                          <p className="text-xs font-medium text-emerald-700">
                            Refund {money(line.unitRefund ?? line.sellingPrice)} per unit
                          </p>
                          {(line.discountApplied ?? 0) > 0 && (
                            <p className="text-[10px] text-amber-600">
                              Discount/benefit deducted: {money(line.discountApplied ?? 0)}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{line.quantity}</td>
                        <td className="px-3 py-2 text-right">{line.returnedQuantity}</td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            data-testid={`refund-qty-${line.lineId}`}
                            min="0"
                            max={line.returnableQuantity}
                            step="1"
                            value={refundLines[line.lineId]?.quantity ?? ""}
                            disabled={line.returnableQuantity <= 0}
                            onChange={(e) =>
                              setRefundLines((prev) => ({
                                ...prev,
                                [line.lineId]: { ...(prev[line.lineId] ?? { restock: true }), quantity: e.target.value },
                              }))
                            }
                            className="ms-auto w-20"
                          />
                          <p className="mt-0.5 text-[10px] text-slate-400">{line.returnableQuantity} left</p>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={refundLines[line.lineId]?.restock !== false}
                            disabled={line.itemType === "direct" || line.returnableQuantity <= 0}
                            onChange={(e) =>
                              setRefundLines((prev) => ({
                                ...prev,
                                [line.lineId]: { ...(prev[line.lineId] ?? { quantity: "" }), restock: e.target.checked },
                              }))
                            }
                            className="h-4 w-4 rounded border-slate-300 text-blue-600"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Transaction type">
                  <Select
                    value={refundMode}
                    onChange={(v) => setRefundMode(v as "refund" | "exchange")}
                    options={[
                      { value: "refund", label: "Refund only" },
                      { value: "exchange", label: "Exchange with current cart" },
                    ]}
                  />
                </FormField>
                <FormField label="Reason" required>
                  <div className="space-y-2">
                    <Select
                      value={refundReasonChoice}
                      onChange={setRefundReasonChoice}
                      options={REFUND_REASONS}
                    />
                    {refundReasonChoice === OTHER_REASON && (
                      <Input
                        value={refundCustomReason}
                        onChange={(e) => setRefundCustomReason(e.target.value)}
                        placeholder="Describe the reason"
                        autoFocus
                      />
                    )}
                  </div>
                </FormField>
              </div>

              {refundMode === "exchange" && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                  Replacement cart: {cart.reduce((s, i) => s + i.quantity, 0)} item(s) · {money(totals.total)}
                  {cart.length === 0 && <span className="block text-xs text-blue-700">Add replacement items to the cart first.</span>}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Refund method (when refund exceeds replacement)">
                  <Select
                    value={refundMethod}
                    onChange={(v) => setRefundMethod(v as typeof refundMethod)}
                    options={[
                      { value: "cash", label: "Cash" },
                      { value: "card", label: "Card" },
                      { value: "transfer", label: "Bank transfer" },
                      { value: "credit", label: "Store credit" },
                    ]}
                  />
                </FormField>
                {refundMode === "exchange" && refundNet > 0 && (
                  <FormField label="Collect difference via">
                    <Select
                      value={refundPayMethod}
                      onChange={(v) => setRefundPayMethod(v as typeof refundPayMethod)}
                      options={[
                        { value: "cash", label: "Cash" },
                        { value: "card", label: "Card" },
                        { value: "transfer", label: "Bank transfer" },
                      ]}
                    />
                  </FormField>
                )}
              </div>

              <FormField label="Note">
                <Textarea rows={2} value={refundNote} onChange={(e) => setRefundNote(e.target.value)} placeholder="Optional note" />
              </FormField>

              <div className="space-y-1 rounded-xl bg-slate-50 p-3 text-sm">
                <div className="flex justify-between text-slate-600"><span>Refund value</span><span>{money(refundSelection.total)}</span></div>
                {refundMode === "exchange" && (
                  <div className="flex justify-between text-slate-600"><span>Replacement total</span><span>{money(refundReplacementTotal)}</span></div>
                )}
                <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-bold text-slate-900">
                  <span>{refundNet > 0 ? "Collect from customer" : refundNet < 0 ? "Refund to customer" : "Even exchange"}</span>
                  <span>{money(Math.abs(refundNet))}</span>
                </div>
                <p className="text-xs text-slate-500">
                  Returned stock is restored only for lines marked Restock. Direct-sale lines never affect inventory.
                  Earned reward credit is reversed proportionally.
                </p>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Direct sale — market goods resold without inventory */}
      <Modal
        open={directOpen}
        onClose={() => setDirectOpen(false)}
        title="Direct sale"
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setDirectOpen(false)}>Cancel</Button>,
          <Button key="add" onClick={addDirectToCart}>Add to cart</Button>,
        ]}
      >
        <div className="space-y-3">
          <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
            For products bought directly from the market and sold to a customer. Regular inventory is not
            increased or decreased, and the line is recorded in sales, receipts and profit reports.
          </p>
          <FormField label="Product description" required>
            <Input
              value={directForm.description}
              onChange={(e) => setDirectForm({ ...directForm, description: e.target.value })}
              placeholder="e.g. Fresh grapes (market)"
              autoFocus
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Quantity" required>
              <Input
                type="number"
                min="1"
                step="1"
                value={directForm.quantity}
                onChange={(e) => setDirectForm({ ...directForm, quantity: e.target.value })}
              />
            </FormField>
            <FormField label="Selling price" required>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={directForm.price}
                onChange={(e) => setDirectForm({ ...directForm, price: e.target.value })}
                placeholder="0.00"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Cost (optional)" hint="Used for profit calculations">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={directForm.cost}
                onChange={(e) => setDirectForm({ ...directForm, cost: e.target.value })}
                placeholder="0.00"
              />
            </FormField>
            <FormField label="Tax (%)">
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={directForm.tax}
                onChange={(e) => setDirectForm({ ...directForm, tax: e.target.value })}
              />
            </FormField>
          </div>
          {directError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{directError}</p>}
        </div>
      </Modal>

      {/* Barcode labels — search, generate and print from inside the POS */}
      <Modal open={barcodeOpen} onClose={() => setBarcodeOpen(false)} title="Barcode labels" size="md">
        <div className="space-y-3">
          <FormField label="Find product" hint="Search by name, SKU or barcode — a scanner can type here">
            <Input
              value={barcodeSearch}
              onChange={(e) => setBarcodeSearch(e.target.value)}
              placeholder="Search or scan…"
              autoFocus
            />
          </FormField>

          {barcodeResults.length > 0 && (
            <ul className="max-h-40 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
              {barcodeResults.map((p) => (
                <li key={p._id}>
                  <button
                    onClick={() => setBarcodeSelected(p)}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50",
                      barcodeSelected?._id === p._id && "bg-blue-50"
                    )}
                  >
                    <span className="font-medium text-slate-900">{p.name}</span>
                    <span className="text-xs text-slate-400">{p.sku} · {p.barcode || "no barcode"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {barcodeSelected && (
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-semibold text-slate-900">{barcodeSelected.name}</p>
              <p className="text-xs text-slate-400">{barcodeSelected.sku}</p>
              {barcodeSelected.barcode ? (
                <div className="mt-2 flex justify-center rounded-lg bg-white p-2">
                  <BarcodeSvg value={barcodeSelected.barcode} height={44} fontSize={10} />
                </div>
              ) : (
                <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                  This product has no barcode yet — generate one below.
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <FormField label="Copies">
                  <Input
                    type="number"
                    min="1"
                    max="200"
                    step="1"
                    value={barcodeCopies}
                    onChange={(e) => setBarcodeCopies(e.target.value)}
                  />
                </FormField>
                <FormField label="Label size">
                  <Select
                    value={barcodeSize}
                    onChange={(v) => setBarcodeSize(v as LabelSize)}
                    options={LABEL_SIZES.map((s) => ({ value: s.value, label: s.label }))}
                  />
                </FormField>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={!barcodeSelected.barcode}
                  onClick={() => setBarcodePrint({ ...barcodeSelected })}
                >
                  Print barcode
                </Button>
                <Button variant="secondary" loading={barcodeBusy} onClick={() => void generateBarcode()}>
                  Generate barcode
                </Button>
              </div>
            </div>
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
                onClick={() => selectCustomer(c)}
                className="flex w-full items-center justify-between px-2 py-2.5 text-left hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">{c.name}</p>
                  <p className="text-xs text-slate-400">
                    {c.phone}
                    {c.wholesaleEligible ? " · wholesale" : ""}
                    {(c.bonusPercent ?? 0) > 0 ? ` · ${c.bonusPercent}% bonus` : ""}
                  </p>
                </div>
                <div className="text-end">
                  {c.balance > 0 && <span className="block text-xs font-medium text-amber-600">owes {money(c.balance)}</span>}
                  {(c.bonusBalance ?? 0) > 0 && (
                    <span className="block text-xs font-medium text-green-600">bonus {money(c.bonusBalance ?? 0)}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      {/* Employee picker (employee purchase mode) */}
      <Modal open={employeeModalOpen} onClose={() => setEmployeeModalOpen(false)} title="Employee purchase" size="sm">
        <Input
          value={employeeSearch}
          onChange={(e) => setEmployeeSearch(e.target.value)}
          placeholder="Search employee name, email or phone"
          autoFocus
        />
        <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-auto">
          {employeeBusy && <li className="py-3 text-center text-xs text-slate-400">Searching…</li>}
          {!employeeBusy && employeeResults.length === 0 && (
            <li className="py-6 text-center text-sm text-slate-400">{tr.common.noData}</li>
          )}
          {employeeResults.map((e) => (
            <li key={e._id}>
              <button
                onClick={() => selectEmployee(e)}
                className="flex w-full items-center justify-between px-2 py-2.5 text-left hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">{e.name}</p>
                  <p className="text-xs text-slate-400">
                    {e.departmentName || "No department"} · benefit {e.benefitPercent}%
                  </p>
                </div>
                <div className="text-end">
                  {e.outstanding > 0 && (
                    <span className="block text-xs font-medium text-amber-600">owes {money(e.outstanding)}</span>
                  )}
                </div>
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
          canViewSales && lastSale ? (
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
            {lastSale.awaitingSync && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                {tr.offline.saleQueued}
              </p>
            )}
            {lastSale.changeAmount > 0 && (
              <p className="text-lg font-bold text-green-700">Change due: {money(lastSale.changeAmount)}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Printable barcode labels (hidden on screen, printed on demand) */}
      {barcodePrint && barcodePrint.barcode && (
        <BarcodePrintSheet
          product={{
            productName: barcodePrint.name,
            sku: barcodePrint.sku,
            barcode: barcodePrint.barcode,
            price: barcodePrint.sellingPrice,
          }}
          copies={Math.max(1, Math.min(200, Math.floor(Number(barcodeCopies) || 1)))}
          size={barcodeSize}
          storeName={storeName}
        />
      )}

      {/* Printable receipt (hidden on screen, printed automatically on completion) */}
      {receipt && <PrintableReceipt data={receipt} />}
    </div>
  );
}
