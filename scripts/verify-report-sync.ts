/**
 * Verifies the Profit report, Sales report and Dashboard KPIs agree for the
 * same window on live data (the point of the returns-netting refactor).
 *
 * Usage: start the app, then: npx tsx scripts/verify-report-sync.ts [baseUrl]
 */
import "dotenv/config";
import { connectDB, disconnectDB } from "../src/lib/mongodb";
import { createAccessToken } from "../src/utils/auth";
import { User } from "../src/models";

const BASE = process.argv[2] ?? "http://localhost:3000";
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} ${extra}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

async function get(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return res.json() as Promise<Record<string, never>>;
}

async function main() {
  await connectDB();
  const admin = await User.findOne({ email: "admin@pos.local" }).lean<{ _id: unknown; roleId: unknown } | null>();
  if (!admin) {
    console.log("No admin user — run seed-demo first");
    process.exit(1);
  }
  const cookie = `pos_access_token=${createAccessToken(String(admin._id), String(admin.roleId))}`;

  // Profit report (default window = last 30 days)
  const profit = await get("/api/reports/profit", cookie);
  const ps = profit.summary as unknown as {
    revenue: number; grossRevenue: number; cogs: number; grossProfit: number;
    netProfit: number; expenses: number; refunds: number;
  };

  // Dashboard for the same 30-day window
  const dash = await get("/api/dashboard?days=30", cookie);
  const dr = dash.range as unknown as {
    sales: number; grossProfit: number; netProfit: number; expenses: number; refunds: number;
  };

  console.log(`profit report: netRevenue=${ps.revenue} cogs=${ps.cogs} gross=${ps.grossProfit} net=${ps.netProfit} refunds=${ps.refunds}`);
  console.log(`dashboard    : sales=${dr.sales} grossProfit=${dr.grossProfit} netProfit=${dr.netProfit} refunds=${dr.refunds}`);

  check("refunds agree (profit report vs dashboard)", near(ps.refunds, dr.refunds), `${ps.refunds} vs ${dr.refunds}`);
  // Dashboard `sales` is tax-inclusive ($total − refunds); the profit report's
  // headline revenue is tax-exclusive. grossRevenue is the like-for-like figure.
  check("gross revenue agrees (report grossRevenue vs dashboard sales)", near(ps.grossRevenue, dr.sales), `${ps.grossRevenue} vs ${dr.sales}`);
  check("net revenue ≤ gross revenue (tax-exclusive basis)", ps.revenue <= ps.grossRevenue + 0.02, `${ps.revenue} vs ${ps.grossRevenue}`);
  check("gross profit agrees", near(ps.grossProfit, dr.grossProfit), `${ps.grossProfit} vs ${dr.grossProfit}`);
  check("net profit agrees", near(ps.netProfit, dr.netProfit), `${ps.netProfit} vs ${dr.netProfit}`);
  check("internal: gross = revenue − cogs", near(ps.grossProfit, ps.revenue - ps.cogs), `${ps.grossProfit} vs ${ps.revenue - ps.cogs}`);
  check("internal: net = gross − expenses", near(ps.netProfit, ps.grossProfit - ps.expenses), `${ps.netProfit} vs ${ps.grossProfit - ps.expenses}`);

  // Daily rows must sum to the summary (no more mismatched buckets).
  const daily = profit.daily as unknown as Array<{ revenue: number; cogs: number; grossProfit: number; expenses: number; netProfit: number }>;
  const sum = (f: (r: { revenue: number; cogs: number; grossProfit: number; expenses: number; netProfit: number }) => number) =>
    Math.round(daily.reduce((s, r) => s + f(r), 0) * 100) / 100;
  check("daily rows sum to summary revenue", near(sum((r) => r.revenue), ps.revenue), `${sum((r) => r.revenue)} vs ${ps.revenue}`);
  check("daily rows sum to summary cogs", near(sum((r) => r.cogs), ps.cogs), `${sum((r) => r.cogs)} vs ${ps.cogs}`);
  check("daily rows sum to summary gross profit", near(sum((r) => r.grossProfit), ps.grossProfit), `${sum((r) => r.grossProfit)} vs ${ps.grossProfit}`);
  check("daily rows sum to summary net profit", near(sum((r) => r.netProfit), ps.netProfit), `${sum((r) => r.netProfit)} vs ${ps.netProfit}`);

  // Sales report net sales should equal the same net revenue figure.
  const sales = await get("/api/reports/sales?period=month", cookie);
  const ss = sales.summary as unknown as { revenue: number; netSales: number; refunds: number };
  const dashMonth = await get("/api/dashboard?days=30", cookie);
  const drm = dashMonth.range as unknown as { sales: number; refunds: number };
  check("sales report net = gross − refunds", near(ss.netSales, ss.revenue - ss.refunds), `${ss.netSales} vs ${ss.revenue - ss.refunds}`);
  check("sales report refunds within dashboard range refunds", ss.refunds <= drm.refunds + 0.02, `${ss.refunds} vs ${drm.refunds}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await disconnectDB();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-report-sync crashed:", err);
  process.exit(1);
});
