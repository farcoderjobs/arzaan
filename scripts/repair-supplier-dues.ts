/**
 * Reconciles Purchase.dueAmount with recorded supplier payment history.
 *
 * Payments recorded through Finance → Supplier Payments before the allocation
 * logic existed reduced the supplier balance but never reduced the per-purchase
 * `dueAmount`, so Purchases kept showing money as "due" that had already been
 * paid. This replays the unallocated pool over the open purchases (oldest
 * first — same order the runtime allocation uses) and is idempotent: a second
 * run finds pool = 0 and changes nothing.
 *
 * Run: npx tsx scripts/repair-supplier-dues.ts [--apply]
 *      (without --apply it only prints what would change)
 */
import { connectDB, disconnectDB } from "@/lib/mongodb";
import { Purchase, SupplierTransaction } from "@/models";
import { round2 } from "@/lib/commerce";

const APPLY = process.argv.includes("--apply");

async function main() {
  await connectDB();

  const suppliers = await SupplierTransaction.distinct("supplierId");
  let changed = 0;

  for (const supplierId of suppliers) {
    const sid = String(supplierId);

    // Payments made after purchase creation (finance payments). Payments taken
    // at purchase creation are already baked into paidAmount/dueAmount and are
    // identified by referenceType "purchase".
    const payTx = await SupplierTransaction.find({
      supplierId,
      type: "payment",
      referenceType: { $ne: "purchase" },
    }).lean();
    const financePaid = round2(payTx.reduce((s, t) => s + Math.abs(t.amount), 0));

    const openPurchases = await Purchase.find({
      supplierId,
      status: { $in: ["pending", "completed"] },
    }).sort({ createdAt: 1 });

    // What the allocation has already applied to these purchases.
    const alreadyAllocated = round2(
      openPurchases.reduce(
        (s, p) => s + ((p.total - p.paidAmount) - p.dueAmount),
        0
      )
    );

    let pool = round2(financePaid - alreadyAllocated);
    if (pool <= 0) {
      console.log(`supplier ${sid}: pool=${pool} (financePaid=${financePaid}, allocated=${alreadyAllocated}) — ok`);
      continue;
    }

    console.log(`supplier ${sid}: financePaid=${financePaid}, alreadyAllocated=${alreadyAllocated}, replaying pool=${pool}`);
    for (const purchase of openPurchases) {
      if (pool <= 0) break;
      // Incremental: only ever LOWER dueAmount by what the pool still holds,
      // so a purchase already reduced by earlier allocations is never re-raised.
      const applied = round2(Math.min(pool, purchase.dueAmount));
      if (applied > 0) {
        const newDue = round2(purchase.dueAmount - applied);
        console.log(
          `  ${purchase.purchaseNumber}: due ${purchase.dueAmount} -> ${newDue} (total=${purchase.total}, paid=${purchase.paidAmount}, applied=${applied})`
        );
        purchase.dueAmount = newDue;
        if (APPLY) await purchase.save();
        changed++;
        pool = round2(pool - applied);
      }
    }
  }

  console.log(APPLY ? `APPLIED — ${changed} purchase(s) updated` : `DRY RUN — ${changed} purchase(s) would change (re-run with --apply)`);
  await disconnectDB();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
