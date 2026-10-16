# Retail POS — User Manual

A retail Point-of-Sale web app built with Next.js + MongoDB. This manual covers
how to start it, log in, and use every module in day-to-day operation.

---

## 1. Quick start

### 1.1 Requirements
- **Node.js 20+**
- **MongoDB** running locally (or a MongoDB Atlas connection string)

### 1.2 Configure
Create a file named `.env` in the project root (copy `.env.example` if present):

```env
MONGODB_URI="mongodb://127.0.0.1:27017"
MONGODB_DB_NAME="pos"
JWT_SECRET="change-me-to-a-long-random-string-at-least-32-chars"
JWT_EXPIRES_IN="1d"
JWT_REFRESH_EXPIRES_IN="30d"
APP_URL="http://localhost:3000"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

> `JWT_SECRET` must be **at least 32 characters** or the app refuses to start.

### 1.3 Install, seed, run
```bash
npm install
npm run seed        # creates the 5 roles + full permission catalog
npx tsx src/scripts/seed-demo.ts   # demo branch, users, categories, products
npm run dev
```

### 1.4 Open the app
| What | URL |
|---|---|
| **App (login page)** | **http://localhost:3000/login** |
| Dashboard (after login) | http://localhost:3000/dashboard |
| POS screen | http://localhost:3000/pos |

> Visiting `http://localhost:3000/` directly returns 404 — that is expected;
> there is no public landing page. Start at `/login`.

### 1.5 Default logins (demo seed)
| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@pos.local` | `admin123` |
| Cashier | `cashier@pos.local` | `cashier123` |

**Change these passwords before real use** (Users → Change Password).

---

## 2. Logging in

1. Go to `http://localhost:3000/login`.
2. Enter email + password, click **Sign in**.
3. You land on the **Dashboard**.

- **Pick your language** with the 🌐 button (top-right of the login page and the
  app header): **English / دری / پښتو**. The whole interface (and RTL layout)
  switches instantly; the choice is remembered in a cookie.
- **Log out**: avatar (top-right) → **Sign out**.
- Wrong password / inactive account → safe error messages (there is no
  lockout in this build; retry after checking the credentials).
- Sessions expire automatically; you'll be redirected to `/login` when they do.

---

## 3. A tour of the interface

- **Left sidebar** — all modules, grouped (Main / Procurement / Finance /
  System). Items you have no permission for are hidden automatically.
- **Top header** — date, language switcher, notifications bell, user menu.
- **Content area** — each page has breadcrumbs, filters, tables, and modals.
- Tables support **search, filters, pagination**; forms validate inline
  (red messages under fields); actions ask for confirmation where destructive.

---

## 4. Modules

### 4.1 Dashboard (`/dashboard`)
KPI cards for the selected period (Today / 7 / 14 / 30 days): sales,
transactions, gross & net profit, expenses, cash/card/credit split,
receivables, payables, low- and out-of-stock counts. Charts: sales over time,
revenue vs COGS, profit over time, sales by category, payment methods.
Panels: Top products, Low-stock alerts, Recent sales.
Range picker + **Refresh** button re-query the server.

### 4.2 POS (`/pos`) — the cashier screen
Optimized for speed and barcode scanners.

| Key | Action |
|---|---|
| **F2** | focus search / scanner box |
| **F3** | select customer |
| **F4** | open payment |
| **F7** | hold sale |
| **F8** | resume held sale |
| **F9** | complete sale |

Workflow:
1. **Scan a barcode** (or type name/SKU) → press **Enter** → item is added.
   Alternatively click a product tile in the grid; filter by category.
2. Adjust **quantity** (+/−), per-line **Disc** (amount).
3. Optional: pick a **customer** (required for credit sales).
4. **Sale discount** — amount or %, applied at the bottom of the cart.
5. Click **Pay (F4)**:
   - choose **method**: Cash / Card / Bank Transfer / Credit (customer account)
   - **Split payment**: add several lines (e.g. $5 cash + $5 card)
   - cash overpayment → **Change** is calculated automatically
   - credit requires a customer; remaining balance lands on their account
6. **Complete Sale (F9)** → receipt confirmation.
   - Cash sales require an **open register** (see 4.5) — the server enforces it.
   - The server re-validates prices, stock, discounts and totals — the client
     is never trusted.

### 4.3 Products (`/products`)
- **Search** by name, **SKU**, or **barcode** (selector), filter by category /
  brand / status, paginated.
- **Add Product** (top-right): name, SKU, barcode, category, brand, unit,
  cost/selling price, tax, minimum stock, image URL, description, status.
- Rules enforced: unique SKU & barcode, no negative prices, category must exist.
- **Edit / view** via row icons; **deactivate** instead of delete — products
  with sales/inventory history are never hard-deleted.

### 4.4 Inventory (`/inventory`)
- **Stock overview** per product: current stock (computed from the movement
  ledger), reorder point, status chips (OK / **Low** / **Out of stock**).
- Filters + low/out-of-stock stat cards.
- **Adjust** (per product): enter quantity (IN or OUT) + required **reason** →
  creates an `ADJUSTMENT` movement. Direct stock editing is not possible;
  **every stock change is a ledger movement** (`/inventory` shows the history).
- Movements recorded: purchase in, sale out, customer return in, supplier
  return out, adjustment in/out, stock count in/out.

### 4.5 Suppliers & Purchases
**Suppliers (`/suppliers`)** — list, create, edit, ledger (balance computed
from transactions), record **payments**.

**Purchases (`/purchases`)** — stock entering the store.
1. **New Purchase**: pick supplier, add product lines (qty, purchase price,
   discount, tax), choose payment method, enter **paid amount**.
2. **Complete**: purchase is saved, **stock enters inventory**
   (PURCHASE_IN movements at purchase price), supplier transaction recorded,
   paid amount creates a payment; unpaid part becomes supplier debt.
3. **History & details**: every purchase, printable view, status
   (pending/completed/canceled).
4. **Cancel**: only unpaid drafts; completed purchases with payments must be
   corrected via **supplier returns** instead.
5. Supplier payments appear in Finance → Supplier Payments.

### 4.6 Customers (`/customers`)
- **List**: search, create, edit, status.
- **Details page**: purchase history, **ledger** (sales, payments, refunds —
  balance always derived from transactions), record **payment**.
- **Credit sales** increase what a customer owes; **payments** reduce it.
  Overpayment is rejected unless explicitly allowed.
- Balance example: credit sale +10,000 → payment −4,000 → balance 6,000.

### 4.7 Sales & Returns
**Sales (`/sales`)** — full history: invoice #, date, customer, cashier,
total, method, status. Filters: date range, customer, cashier, payment
method, status, invoice search. **Details (`/sales/[id]`)**: items, qty,
prices, discounts, tax, payments, and **Print Receipt** / **Reprint** —
80 mm printer-friendly layout; internal cost is never shown on receipts.

**Returns (`/returns`)**:
1. **New Return** → enter the invoice number → sale loads.
2. Set return **quantity per item** (full or partial) + **reason**.
3. Choose **refund method**: Cash / Original payment / Store credit.
4. Submit → if the store setting requires it, a manager **approves**.
5. Effects once approved: stock returns via `CUSTOMER_RETURN_IN`, refund
   posted (cash leaves the register drawer), original sale is **never
   modified**, returns can never exceed the sold quantity.

### 4.8 Cash Register (`/cash-register`)
Per-cashier drawer sessions.
- **Open register**: enter **opening cash**.
- During the day: cash sales, refunds, expenses, income all flow in/out —
  every movement is a `CashTransaction` row.
- **Expected cash** = opening + cash sales + income − refunds − expenses.
- **Close register**: count the drawer, enter **actual cash** → the app shows
  opening, sales, refunds, expenses, expected, actual and the **difference**.
- One open register per cashier (a setting can allow more); cash sales
  without an open register are rejected.

### 4.9 Finance (`/finance`)
Four sections:
- **Expenses** — create (category: rent, electricity, internet, salary,
  transport, maintenance, packaging, other; amount, method, reference, date),
  edit, **cancel** (kept for audit — never silently deleted). Cash expenses
  deduct from the open drawer.
- **Customer Payments** — history + record new.
- **Supplier Payments** — history + record new.
- **Cash Transactions** — every drawer movement.
Every financial record stores amount, type, method, reference, user, branch,
timestamp. Normal users cannot physically delete financial records.

### 4.10 Reports (`/reports`)
Nine reports, each with **day / week / month / custom range** filters,
pagination, and **CSV export** where useful:
- **Sales** — by day/cashier/customer/payment method/category (net of refunds)
- **Products** — qty sold, revenue, COGS, gross profit; best / slow / never sold
  (per-product returned quantities are netted out)
- **Inventory** — current stock, low/out, valuation, movements, adjustments
- **Purchases** — totals, by supplier/product, outstanding supplier balances
- **Customers** — purchases, payments, outstanding balances
- **Suppliers** — purchase volume, balances
- **Finance** — expenses, cash flow, receivables, payables
- **Profit** — Revenue − COGS = Gross Profit; − Expenses = Net Profit
  (COGS uses the **cost price stored on each historical sale item**, so old
  sales stay correct when prices change)
- **Online Store** — storefront orders, revenue, best sellers, order status

> **Refunds everywhere:** approved returns reduce revenue and COGS in the
> Sales, Products and Profit reports exactly like the Dashboard KPIs — both
> screens use one shared calculation (`src/lib/report-returns.ts`), so the
> numbers can never drift apart. Returns are counted at the moment they are
> **approved**.

### 4.11 Online Store (public storefront at `/`)
A small ecommerce shop, separate from the POS catalog:

**Admin side**
- **Store Products** (`/store-products`, permission `store.manage`) — add,
  edit, hide and delete the products sold online: name, description, price,
  optional compare-at price (strike-through), category, stock, card accent,
  image URL, featured flag. Only products added here appear online; POS
  products are never exposed.
  - **Add product** opens the dedicated page `/store-products/new`, which
    shows a **live preview of the storefront card** next to the form.
    Editing an existing product still uses the inline dialog in the table.
  - `npm run seed:store` seeds 12 ready-made demo products (idempotent —
    it skips products whose slug already exists).
- **Store Orders** (`/store-orders`, permission `store.orders`) — every order
  with the buyer's **name and phone number**, address, note and items.
  Status flow: pending → confirmed → shipped → delivered (or canceled).
  **Canceling puts the items back in stock.**
- The store has its own **report** at Reports → Online Store (section 4.10).

**Customer side (`/` — no login)**
- Clean, light storefront: hero with search, category chips, trust strip and
  product cards (accent tint, category emoji or photo, low-stock and
  sold-out badges) on a white/slate layout.
- Cart drawer (kept in the browser between visits) → checkout asks for
  **name, phone (required), delivery address and an optional note**.
- Orders are **priced on the server** (a tampered cart cannot change the
  total), stock is reserved atomically (no overselling), and the customer
  gets an order number such as `WEB-20261012-1234`. Payment is on delivery;
  staff call the phone number to confirm.

New permissions (seeded by `npm run seed`): `store.view`, `store.manage`,
`store.orders`, `reports.store`. Super Admin and Manager have them all;
Accountant also gets `store.view`, `store.orders` and `reports.store`.

### 4.12 Users & Access (`/users`, `/roles`, `/permissions`, `/audit-logs`)
- **Users** — create/edit, activate/deactivate, change password, assign role &
  branch, view activity. The final active Super Admin cannot be deactivated.
- **Roles** — create/edit/clone, assign granular permissions
  (e.g. `products.create`, `sales.refund`, `cash_register.open`).
  Five system roles are pre-seeded: Super Admin (all), Manager, Cashier,
  Inventory Manager, Accountant.
- **Permissions** — matrix view of every role × permission.
- **Audit Logs** — read-only trail of logins, price changes, inventory
  adjustments, purchases, cancellations, refunds, payments, user/role/setting
  changes, register actions. Cannot be edited or deleted by users.

### 4.13 Settings (`/settings`)
Tabs:
- **Store** — name, logo, address, phone, email, currency, tax rate,
  invoice prefix.
- **POS** — allow negative stock, max cashier discount %, require customer
  for credit, auto-print receipt, refund approval, default payment method.
- **Inventory** — low-stock threshold, allow negative inventory, valuation.
- **Branches** — add/edit branches (name, address, phone, status). Users
  assigned to a branch only see that branch's data; Super Admin sees all.

---

## 5. A typical day (cheat sheet)

1. **Open register** with opening cash (Cashier).
2. Sell all day at **/pos** — scan, F4 to pay, F9 to complete. Hold carts
   (F7) when customers step away.
3. **Customer pays their account** → Customers → record payment.
4. **Expense** (taxi, tea) → Finance → Expenses.
5. **Goods arrive** → Purchases → new purchase → complete → stock in.
6. **Return** → Sales → open the invoice → New Return.
7. **Close register**, count cash, check the difference.
8. Manager: check **Dashboard** + **Reports**, export CSVs, review
   **Audit Logs**.

---

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `MONGODB_URI` / `JWT_SECRET` error at startup | `.env` missing or invalid — see 1.2 (secret ≥ 32 chars) |
| Can't log in | Seed users first (1.3); account must be `active` |
| "Cash sale requires an open register" | Cash Register → Open Register |
| Stock won't go below zero | That's the `allowNegativeStock` / `allowNegativeInventory` setting (Settings → POS / Inventory) |
| Port 3000 busy | `npm run dev -- -p 3001` then use http://localhost:3001/login |
| Language switched to one you can't read | 🌐 button → English (button is in the same place on the login screen) |
| Reset demo data | Re-run `npx tsx src/scripts/seed-demo.ts` (it skips existing records) |

---

## 7. For developers

| Command | Purpose |
|---|---|
| `npm run dev` | dev server on :3000 |
| `npm run build` / `npm start` | production build / serve |
| `npm run lint` | ESLint (currently 0 errors) |
| `npx tsc --noEmit` | TypeScript check |
| `npm test` | 49 unit tests (pricing, payments, branch access) |
| `npm run seed` | roles + permissions |
| `npx tsx src/scripts/seed-demo.ts` | demo data |
| `npx tsx scripts/smoke-modules.ts` | integration smoke tests (needs running app + DB) |
| `npx tsx scripts/smoke-store.ts` | online store end-to-end smoke test (needs running app + DB) |
| `npx tsx scripts/verify-report-sync.ts` | asserts Profit/Sales reports match Dashboard KPIs (needs running app + DB) |

**Architecture:** `src/app` (pages & APIs) · `src/components` (UI) ·
`src/lib` (services: sales, returns, cash, finance, auth, RBAC, settings) ·
`src/models` (Mongoose schemas) · `src/i18n` (en/fa/ps) · `src/validations`
(zod). Ledger architecture: stock, customer and supplier balances are always
computed from their transaction ledgers, never stored as editable fields.

**Security model:** httpOnly JWT cookies, bcrypt password hashing, RBAC on
every API route and page, branch isolation (`branchScope`), append-only audit
log. Hiding UI is not security — the server re-checks every permission.
