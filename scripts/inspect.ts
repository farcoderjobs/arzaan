/** One-off DB inspection for the bug batch. Run: npx tsx scripts/inspect.ts */
import "dotenv/config";
import mongoose from "mongoose";

async function main() {
  const conn = await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB_NAME! });
  const db = conn.connection.db!;

  const sales = await db.collection("sales").aggregate([
    { $project: { invoiceNumber: 1, status: 1, total: 1, paymentMethod: 1, customerId: 1, payments: 1, createdAt: 1 } },
    { $sort: { createdAt: -1 } },
    { $limit: 10 },
  ]).toArray();
  console.log("recent sales:");
  for (const s of sales) {
    console.log(`  ${s.invoiceNumber} ${s.status} total=${s.total} method=${s.paymentMethod} customerId=${s.customerId ?? "none"} payments=${JSON.stringify(s.payments)}`);
  }

  const byMethod = await db.collection("sales").aggregate([
    { $group: { _id: "$paymentMethod", n: { $sum: 1 }, withCustomer: { $sum: { $cond: [{ $ne: ["$customerId", null] }, 1, 0] } } } },
  ]).toArray();
  console.log("sales by method:", JSON.stringify(byMethod));

  const creditSales = await db.collection("sales").find({ "payments.method": "credit" }).project({ invoiceNumber: 1, total: 1, customerId: 1, payments: 1 }).toArray();
  console.log(`credit sales: ${creditSales.length}`);
  for (const s of creditSales.slice(0, 5)) console.log(`  ${s.invoiceNumber} total=${s.total} cust=${s.customerId} ${JSON.stringify(s.payments)}`);

  const txCount = await db.collection("customertransactions").countDocuments();
  console.log("customertransactions:", txCount);
  const txs = await db.collection("customertransactions").find({}).sort({ createdAt: -1 }).limit(10).toArray();
  for (const t of txs) console.log(`  ${t.type} ${t.amount} cust=${t.customerId} ${t.description}`);

  const customers = await db.collection("customers").find({}).project({ name: 1, status: 1 }).toArray();
  console.log("customers:", customers.map((c) => `${c.name}(${c.status})`).join(", "));

  const returns = await db.collection("salereturns").find({}).project({ returnNumber: 1, status: 1, total: 1, createdAt: 1, refundMethod: 1 }).sort({ createdAt: -1 }).limit(10).toArray();
  console.log(`salereturns: ${returns.length}`);
  for (const r of returns) console.log(`  ${r.returnNumber} ${r.status} total=${r.total} method=${r.refundMethod} at=${r.createdAt}`);

  const purchases = await db.collection("purchases").find({}).project({ purchaseNumber: 1, status: 1, total: 1, paidAmount: 1, dueAmount: 1, supplierId: 1 }).sort({ createdAt: -1 }).limit(10 ).toArray();
  console.log("purchases:");
  for (const p of purchases) console.log(`  ${p.purchaseNumber} ${p.status} total=${p.total} paid=${p.paidAmount} due=${p.dueAmount} supplier=${p.supplierId}`);

  const supTx = await db.collection("suppliertransactions").find({}).project({ type: 1, amount: 1, balanceAfter: 1, supplierId: 1, description: 1 }).sort({ createdAt: -1 }).limit(10).toArray();
  console.log("supplier transactions:");
  for (const t of supTx) console.log(`  ${t.type} ${t.amount} balAfter=${t.balanceAfter} supplier=${t.supplierId} ${t.description}`);

  await conn.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
