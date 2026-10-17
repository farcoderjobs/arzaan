"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/utils/classname";
import { money, setCurrency } from "@/lib/currency";
import { success, error as toastError } from "@/utils/toast";

export type StoreProductView = {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  compareAtPrice: number;
  accent: string;
  imageUrl: string;
  category: string;
  stock: number;
  inStock: boolean;
  featured: boolean;
};

type CartLine = { productId: string; name: string; price: number; quantity: number };

/** Per-accent palette: soft tint for the card art, solid color for the CTA. */
const ACCENTS: Record<string, { chip: string; art: string; button: string; badge: string }> = {
  indigo: { chip: "bg-indigo-50 text-indigo-700 ring-indigo-100", art: "from-indigo-100 via-indigo-50 to-white", button: "bg-indigo-600 hover:bg-indigo-500", badge: "from-indigo-500 to-violet-500" },
  emerald: { chip: "bg-emerald-50 text-emerald-700 ring-emerald-100", art: "from-emerald-100 via-emerald-50 to-white", button: "bg-emerald-600 hover:bg-emerald-500", badge: "from-emerald-500 to-teal-500" },
  rose: { chip: "bg-rose-50 text-rose-700 ring-rose-100", art: "from-rose-100 via-rose-50 to-white", button: "bg-rose-600 hover:bg-rose-500", badge: "from-rose-500 to-pink-500" },
  amber: { chip: "bg-amber-50 text-amber-700 ring-amber-100", art: "from-amber-100 via-amber-50 to-white", button: "bg-amber-500 hover:bg-amber-400", badge: "from-amber-500 to-orange-500" },
  sky: { chip: "bg-sky-50 text-sky-700 ring-sky-100", art: "from-sky-100 via-sky-50 to-white", button: "bg-sky-600 hover:bg-sky-500", badge: "from-sky-500 to-blue-500" },
  violet: { chip: "bg-violet-50 text-violet-700 ring-violet-100", art: "from-violet-100 via-violet-50 to-white", button: "bg-violet-600 hover:bg-violet-500", badge: "from-violet-500 to-fuchsia-500" },
  slate: { chip: "bg-slate-100 text-slate-700 ring-slate-200", art: "from-slate-100 via-slate-50 to-white", button: "bg-slate-700 hover:bg-slate-600", badge: "from-slate-500 to-slate-700" },
};

const accentFor = (key: string) => ACCENTS[key] ?? ACCENTS.indigo;

/** Products have no photos by default — a category emoji keeps cards lively. */
function emojiFor(category: string, name: string): string {
  const text = `${category} ${name}`.toLowerCase();
  if (/coffee|espresso|cappuccino/.test(text)) return "☕";
  if (/tea|chai/.test(text)) return "🍵";
  if (/water|juice|drink|beverage|soda|cola|juice/.test(text)) return "🥤";
  if (/chocolate|candy|sweet|snack|chip|crisps|biscuit|cookie/.test(text)) return "🍫";
  if (/bread|bakery|cake|pastry/.test(text)) return "🥐";
  if (/fruit|apple|banana|veg|fresh/.test(text)) return "🍎";
  if (/clean|soap|detergent|household|laundry|trash/.test(text)) return "🧼";
  if (/shampoo|cream|personal|hygiene|toothpaste|razor/.test(text)) return "🧴";
  if (/spice|rice|flour|oil|grocery|pantry/.test(text)) return "🥫";
  return "🛍️";
}

const CART_STORAGE_KEY = "store_cart_v1";

export function Storefront({
  products,
  categories,
  storeName,
  currency,
  storePhone,
}: {
  products: StoreProductView[];
  categories: string[];
  storeName: string;
  currency: string;
  storePhone: string;
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<{ orderNumber: string; total: number } | null>(null);
  const lastCountRef = useRef(0);

  // Money formatting follows the store's configured currency.
  useEffect(() => {
    setCurrency(currency);
  }, [currency]);

  // Restore the persisted cart on mount (localStorage is unavailable during SSR).
  useEffect(() => {
    void (async () => {
      try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as CartLine[];
          if (Array.isArray(parsed)) setCart(parsed.filter((l) => l && l.productId));
        }
      } catch {
        /* ignore corrupt carts */
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      /* storage full/blocked — cart still lives in memory */
    }
  }, [cart]);

  const count = cart.reduce((s, l) => s + l.quantity, 0);
  const subtotal = cart.reduce((s, l) => s + l.price * l.quantity, 0);

  // Pop the cart badge whenever the item count changes.
  useEffect(() => {
    if (count !== lastCountRef.current && lastCountRef.current > 0) {
      const el = document.getElementById("cart-badge");
      el?.classList.remove("store-pop");
      // force reflow so the animation restarts
      void el?.offsetWidth;
      el?.classList.add("store-pop");
    }
    lastCountRef.current = count;
  }, [count]);

  // Toasts are fired outside the state updater: an updater runs during the
  // render phase, and notifying the toast store from there makes React warn
  // "Cannot update a component while rendering a different component".
  const addToCart = (product: StoreProductView) => {
    if (!product.inStock) return;
    const existing = cart.find((l) => l.productId === product.id);
    if (existing) {
      const nextQty = Math.min(existing.quantity + 1, product.stock);
      if (nextQty === existing.quantity) {
        toastError("Stock limit", `Only ${product.stock} available of "${product.name}"`);
        return;
      }
      success("Added to cart", product.name);
      setCart(cart.map((l) => (l.productId === product.id ? { ...l, quantity: nextQty } : l)));
      return;
    }
    success("Added to cart", product.name);
    setCart([...cart, { productId: product.id, name: product.name, price: product.price, quantity: 1 }]);
  };

  const setQty = (productId: string, qty: number) => {
    setCart((prev) => {
      if (qty <= 0) return prev.filter((l) => l.productId !== productId);
      const product = products.find((p) => p.id === productId);
      const max = product ? product.stock : qty;
      return prev.map((l) => (l.productId === productId ? { ...l, quantity: Math.min(qty, max) } : l));
    });
  };

  const qtyOf = (productId: string) => cart.find((l) => l.productId === productId)?.quantity ?? 0;

  const visibleProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      const catOk = activeCategory === "All" || p.category === activeCategory;
      const qOk = !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
      return catOk && qOk;
    });
  }, [products, activeCategory, query]);

  return (
    <div className="store-root min-h-screen bg-slate-50 text-slate-900">
      {/* ---------- Header ---------- */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2.5 sm:gap-4 sm:px-6 sm:py-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base font-black text-white shadow-md shadow-indigo-500/20 bg-gradient-to-br sm:h-10 sm:w-10 sm:text-lg", accentFor("indigo").badge)}>
              {storeName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="max-w-[46vw] truncate text-sm font-bold leading-tight text-slate-900 sm:max-w-none sm:text-base">{storeName}</p>
              <p className="text-[10px] leading-tight text-slate-500 sm:text-[11px]">Online Store</p>
            </div>
          </div>

          <div className="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <a
              href="/login"
              className="hidden rounded-lg px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:block"
            >
              Staff login
            </a>
            <button
              onClick={() => setCartOpen(true)}
              className="group relative flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 active:scale-95 sm:px-4"
              aria-label="Open cart"
            >
              <span className="transition-transform duration-200 group-hover:scale-110">🛒</span>
              <span className="hidden sm:inline">Cart</span>
              <span
                id="cart-badge"
                className={cn(
                  "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold transition-colors",
                  count > 0 ? "bg-emerald-400 text-emerald-950" : "bg-white/20 text-slate-200"
                )}
              >
                {count}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="relative overflow-hidden border-b border-slate-200 bg-gradient-to-b from-indigo-50 via-white to-slate-50">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(15,23,42,0.06)_1px,transparent_0)] [background-size:22px_22px]" />
        <div className="relative mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16 lg:py-20">
          <p className="store-fade-up inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Order online — we call you to confirm
          </p>
          <h1
            className="store-fade-up mt-4 max-w-2xl text-[27px] font-extrabold leading-[1.12] tracking-tight text-slate-900 sm:text-5xl"
            style={{ animationDelay: "60ms" }}
          >
            Hand-picked products,{" "}
            <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-emerald-600 bg-clip-text text-transparent">
              delivered to your door
            </span>
          </h1>
          <p className="store-fade-up mt-3 max-w-xl text-sm leading-relaxed text-slate-600 sm:text-base" style={{ animationDelay: "120ms" }}>
            Add what you like to the cart, leave your phone number, and our team calls you right back to confirm your order.
          </p>

          {/* Search */}
          <div className="store-fade-up mt-6 max-w-lg" style={{ animationDelay: "180ms" }}>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search products…"
                className="w-full rounded-2xl border border-slate-200 bg-white py-3.5 pl-11 pr-4 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition outline-none duration-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
          </div>

          {/* Category chips */}
          {categories.length > 0 && (
            <div className="store-fade-up no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" style={{ animationDelay: "240ms" }}>
              {["All", ...categories].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={cn(
                    "shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition duration-200 active:scale-95",
                    activeCategory === cat
                      ? "bg-slate-900 text-white shadow-md shadow-slate-900/20"
                      : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {/* Trust strip */}
          <div className="store-fade-up mt-10 grid max-w-2xl gap-3 sm:grid-cols-3" style={{ animationDelay: "300ms" }}>
            {[
              { icon: "🚚", title: "Fast delivery", note: "Same-day in the city" },
              { icon: "📞", title: "We call to confirm", note: "No surprises" },
              { icon: "💵", title: "Pay on delivery", note: "Cash when it arrives" },
            ].map((item) => (
              <div key={item.title} className="flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white/80 p-3 shadow-sm backdrop-blur">
                <span className="text-xl">{item.icon}</span>
                <div>
                  <p className="text-xs font-bold text-slate-900">{item.title}</p>
                  <p className="text-[11px] text-slate-500">{item.note}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Product grid ---------- */}
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-slate-900 sm:text-lg">
              {activeCategory === "All" ? "All products" : activeCategory}
            </h2>
            <p className="text-sm text-slate-500">
              {visibleProducts.length} {visibleProducts.length === 1 ? "item" : "items"} available
            </p>
          </div>
          {(query || activeCategory !== "All") && (
            <button
              onClick={() => {
                setQuery("");
                setActiveCategory("All");
              }}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </div>

        {products.length === 0 ? (
          <div className="store-fade-up rounded-3xl border border-slate-200 bg-white p-16 text-center shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-3xl">🛍️</div>
            <h2 className="mt-4 text-xl font-bold text-slate-900">Nothing on the shelves yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              Our team is stocking the online store. Check back soon — new products appear here first.
            </p>
            {storePhone && (
              <p className="mt-4 text-sm text-slate-500">
                Want something specific? Call us: <span className="font-semibold text-slate-900">{storePhone}</span>
              </p>
            )}
          </div>
        ) : visibleProducts.length === 0 ? (
          <div className="store-fade-up rounded-3xl border border-slate-200 bg-white p-16 text-center shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-3xl">🔎</div>
            <h2 className="mt-4 text-xl font-bold text-slate-900">No products match</h2>
            <p className="mt-2 text-sm text-slate-500">Try a different search or category.</p>
            <button
              onClick={() => {
                setQuery("");
                setActiveCategory("All");
              }}
              className="mt-5 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 active:scale-95"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3">
            {visibleProducts.map((product, i) => {
              const accent = accentFor(product.accent);
              const inCart = qtyOf(product.id);
              return (
                <article
                  key={product.id}
                  className="store-fade-up group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition duration-300 hover:-translate-y-1 hover:border-slate-300 hover:shadow-xl hover:shadow-slate-200/60"
                  style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}
                >
                  {/* Art */}
                  <div className={cn("relative h-28 overflow-hidden bg-gradient-to-br sm:h-44", accent.art)}>
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <span className="text-4xl drop-shadow-sm transition duration-500 group-hover:scale-110 sm:text-6xl">
                          {emojiFor(product.category, product.name)}
                        </span>
                      </div>
                    )}
                    {product.featured && (
                      <span className="absolute start-2 top-2 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-amber-950 shadow-sm sm:start-3 sm:top-3 sm:px-2.5 sm:text-[11px]">
                        ⭐ Featured
                      </span>
                    )}
                    {!product.inStock && (
                      <span className="absolute end-2 top-2 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm sm:end-3 sm:top-3 sm:px-2.5 sm:text-[11px]">
                        Sold out
                      </span>
                    )}
                    {product.inStock && product.stock <= 5 && (
                      <span className="absolute end-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold text-amber-700 shadow-sm ring-1 ring-amber-200 sm:end-3 sm:top-3 sm:px-2.5 sm:text-[11px]">
                        Only {product.stock} left
                      </span>
                    )}
                  </div>

                  {/* Body */}
                  <div className="flex flex-1 flex-col p-3 sm:p-5">
                    <span className={cn("line-clamp-1 self-start rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 sm:px-2.5 sm:text-[11px]", accent.chip)}>
                      {product.category}
                    </span>
                    <h3 className="mt-1.5 line-clamp-2 text-sm font-bold leading-snug text-slate-900 transition group-hover:text-indigo-700 sm:mt-2.5 sm:text-base">
                      {product.name}
                    </h3>
                    {product.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500 sm:text-xs">{product.description}</p>
                    )}

                    <div className="mt-auto flex flex-col items-stretch gap-2 pt-3 sm:flex-row sm:items-end sm:justify-between sm:gap-3 sm:pt-4">
                      <div className="min-w-0">
                        <p className="truncate text-base font-black text-slate-900 sm:text-lg">{money(product.price)}</p>
                        {product.compareAtPrice > product.price && (
                          <p className="truncate text-[11px] text-slate-400 line-through sm:text-xs">{money(product.compareAtPrice)}</p>
                        )}
                      </div>
                      <button
                        onClick={() => addToCart(product)}
                        disabled={!product.inStock}
                        className={cn(
                          "w-full rounded-xl px-3 py-2 text-xs font-bold text-white shadow-sm transition duration-200 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none sm:w-auto sm:px-4 sm:py-2.5 sm:text-sm",
                          accent.button
                        )}
                      >
                        {inCart > 0 ? `In cart · ${inCart}` : product.inStock ? "Add to cart" : "Sold out"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* ---------- Footer ---------- */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {storeName} — Online Store
          </p>
          {storePhone && (
            <p>
              Questions? Call us: <span className="font-semibold text-slate-900">{storePhone}</span>
            </p>
          )}
        </div>
      </footer>

      {/* ---------- Cart drawer ---------- */}
      {/* Backdrop and panel are siblings, not parent/child: the panel is always
          fully opaque (even mid-transition) and the backdrop dims on its own, so
          no frame of the opening animation can look washed out or see-through.
          The panel is anchored with `fixed inset-y-0 right-0` directly — no
          intermediate containing block that could reposition it. */}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-slate-900/50 transition-opacity duration-300",
          cartOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setCartOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-2xl transition-transform duration-300 ease-out",
          cartOpen ? "translate-x-0" : "pointer-events-none translate-x-full"
        )}
      >
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-bold text-slate-900">Your cart</h2>
            <button
              onClick={() => setCartOpen(false)}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close cart"
            >
              ✕
            </button>
          </div>

          {cart.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-3xl">🛒</div>
              <p className="font-semibold text-slate-900">Your cart is empty</p>
              <p className="text-sm text-slate-500">Browse the store and add something you love.</p>
              <button
                onClick={() => setCartOpen(false)}
                className="mt-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 active:scale-95"
              >
                Keep shopping
              </button>
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-5 py-4">
                <ul className="space-y-3">                  {cart.map((line) => (
                    <li
                      key={line.productId}
                      className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{line.name}</p>
                          <p className="text-xs text-slate-500">{money(line.price)} each</p>
                        </div>
                        <button
                          onClick={() => setQty(line.productId, 0)}
                          className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`Remove ${line.name}`}
                        >
                          🗑
                        </button>
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
                          <button
                            onClick={() => setQty(line.productId, line.quantity - 1)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 transition hover:bg-white active:scale-90"
                          >
                            −
                          </button>
                          <span className="w-8 text-center text-sm font-bold text-slate-900">{line.quantity}</span>
                          <button
                            onClick={() => setQty(line.productId, line.quantity + 1)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 transition hover:bg-white active:scale-90"
                          >
                            +
                          </button>
                        </div>
                        <p className="text-sm font-bold text-slate-900">{money(line.price * line.quantity)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-slate-200 p-5">
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-sm text-slate-500">Subtotal</span>
                  <span className="text-xl font-black text-slate-900">{money(subtotal)}</span>
                </div>
                <button
                  onClick={() => {
                    setCartOpen(false);
                    setPlacedOrder(null);
                    setCheckoutOpen(true);
                  }}
                  className="w-full rounded-xl bg-indigo-600 py-3.5 text-sm font-bold text-white shadow-md shadow-indigo-500/20 transition duration-200 hover:bg-indigo-500 active:scale-95"
                >
                  Checkout — {money(subtotal)}
                </button>
                <p className="mt-2 text-center text-[11px] text-slate-500">Pay on delivery · No online payment needed</p>
              </div>
            </>
          )}
      </aside>

      {/* ---------- Checkout modal ---------- */}
      {checkoutOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="store-modal-in flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-3xl">
            {placedOrder ? (
              <div className="p-6 text-center sm:p-8">
                <div className="store-pop mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl">✅</div>
                <h2 className="mt-4 text-2xl font-black text-slate-900">Order placed!</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Thanks for your order. We will call you shortly to confirm the details and delivery.
                </p>
                <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">Order number</span>
                    <span className="font-mono font-bold text-indigo-600">{placedOrder.orderNumber}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-slate-500">Total</span>
                    <span className="font-bold text-slate-900">{money(placedOrder.total)}</span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setCheckoutOpen(false);
                    setPlacedOrder(null);
                  }}
                  className="mt-6 w-full rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-800 active:scale-95"
                >
                  Continue shopping
                </button>
              </div>
            ) : (
              <CheckoutForm
                cart={cart}
                subtotal={subtotal}
                onClose={() => setCheckoutOpen(false)}
                onPlaced={(order) => {
                  setCart([]);
                  setPlacedOrder(order);
                }}
                placing={placing}
                setPlacing={setPlacing}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CheckoutForm({
  cart,
  subtotal,
  onClose,
  onPlaced,
  placing,
  setPlacing,
}: {
  cart: CartLine[];
  subtotal: number;
  onClose: () => void;
  onPlaced: (order: { orderNumber: string; total: number }) => void;
  placing: boolean;
  setPlacing: (v: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const nextErrors: Record<string, string> = {};
    if (name.trim().length < 2) nextErrors.name = "Please enter your name";
    if (!/^[0-9+\-() ]{6,30}$/.test(phone.trim())) nextErrors.phone = "Please enter a valid phone number";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setPlacing(true);
    try {
      const res = await fetch("/api/store/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: name.trim(),
          phone: phone.trim(),
          address: address.trim(),
          note: note.trim(),
          items: cart.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError("Could not place order", data?.error?.message ?? "Please try again");
        return;
      }
      success("Order placed", data?.message ?? "We will call you shortly");
      onPlaced({ orderNumber: data.data.orderNumber, total: data.data.total });
    } catch {
      toastError("Network error", "Could not reach the store. Please try again.");
    } finally {
      setPlacing(false);
    }
  };

  const inputClass = (hasError?: string) =>
    cn(
      "w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 transition outline-none duration-200 focus:ring-2",
      hasError ? "border-rose-400 focus:border-rose-500 focus:ring-rose-500/20" : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-500/20"
    );

  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <h2 className="text-lg font-bold text-slate-900">Checkout</h2>
        <button onClick={onClose} className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Order summary */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Order summary</p>
          <ul className="mt-2 space-y-1.5">
            {cart.map((l) => (
              <li key={l.productId} className="flex items-center justify-between text-sm">
                <span className="text-slate-600">
                  {l.name} <span className="text-slate-400">× {l.quantity}</span>
                </span>
                <span className="font-semibold text-slate-900">{money(l.price * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
            <span className="text-sm text-slate-500">Total</span>
            <span className="text-lg font-black text-slate-900">{money(subtotal)}</span>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Your name <span className="text-rose-500">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ahmad Wali"
              className={inputClass(errors.name)}
            />
            {errors.name && <p className="mt-1 text-xs text-rose-500">{errors.name}</p>}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Phone number <span className="text-rose-500">*</span>
            </label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="e.g. 070 123 4567"
              className={inputClass(errors.phone)}
            />
            {errors.phone ? (
              <p className="mt-1 text-xs text-rose-500">{errors.phone}</p>
            ) : (
              <p className="mt-1 text-[11px] text-slate-500">We call this number to confirm your order and delivery.</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Delivery address</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Neighborhood, street, landmark…"
              className={inputClass()}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything we should know?"
              className={cn(inputClass(), "resize-none")}
            />
          </div>
        </div>
      </div>

      <div className="pb-safe border-t border-slate-200 p-5">
        <button
          onClick={submit}
          disabled={placing || cart.length === 0}
          className="w-full rounded-xl bg-indigo-600 py-3.5 text-sm font-bold text-white shadow-md shadow-indigo-500/20 transition duration-200 hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
        >
          {placing ? "Placing order…" : `Place order — ${money(subtotal)}`}
        </button>
        <p className="mt-2 text-center text-[11px] text-slate-500">Cash on delivery · Confirmation by phone</p>
      </div>
    </>
  );
}
