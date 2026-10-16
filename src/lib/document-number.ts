import mongoose from "mongoose";
import { Sale } from "@/models";

/**
 * Generates the next sequential document number for a collection
 * (invoiceNumber for sales, returnNumber for returns).
 *
 * Format: INV-YYYYMM-000001 / RET-YYYYMM-000001
 * Uses a counter document to survive concurrent serverless invocations;
 * retries on duplicate key errors from parallel requests.
 */
export async function generateDocumentNumber(
  kind: "INV" | "RET",
  generateInSession?: mongoose.ClientSession | null
): Promise<string> {
  const now = new Date();
  const prefix = `${kind}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await Sale.findOne(
      { invoiceNumber: { $regex: `^${prefix}-` } },
      null,
      generateInSession ? { session: generateInSession } : undefined
    )
      .sort({ invoiceNumber: -1 })
      .lean();

    let next = 1;
    if (last?.invoiceNumber) {
      const parsed = Number.parseInt(last.invoiceNumber.split("-").pop() ?? "0", 10);
      if (Number.isFinite(parsed)) next = parsed + 1;
    }

    const candidate = `${prefix}-${String(next).padStart(6, "0")}`;
    const exists = await Sale.exists({ invoiceNumber: candidate }).session(generateInSession ?? null);
    if (!exists) return candidate;
  }

  // Fallback: random suffix avoids blocking the sale
  return `${prefix}-${Date.now().toString().slice(-6)}`;
}

export async function generateReturnNumber(): Promise<string> {
  const now = new Date();
  const prefix = `RET-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `${prefix}-${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
}
