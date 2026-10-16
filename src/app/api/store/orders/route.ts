import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { StoreOrder, StoreProduct } from "@/models";
import { badRequest } from "@/lib/api";
import { round2 } from "@/lib/commerce";

/**
 * POST /api/store/orders  (PUBLIC — storefront checkout)
 *
 * The client only sends product ids + quantities; prices and the order total
 * are recomputed server-side from the StoreProduct rows so a tampered cart
 * can never change what is charged. Stock is decremented with a conditional
 * update so two buyers racing for the last unit cannot oversell it.
 */

const checkoutSchema = z.object({
  customerName: z.string().trim().min(2, "Name is required").max(120),
  // Store orders are phone-confirmed, so the phone number is mandatory.
  phone: z
    .string()
    .trim()
    .min(6, "A valid phone number is required")
    .max(30)
    .regex(/^[0-9+\-() ]{6,30}$/, "Enter a valid phone number"),
  email: z.string().trim().email("Invalid email").max(160).optional().or(z.literal("")),
  address: z.string().trim().max(400).optional().or(z.literal("")),
  note: z.string().trim().max(400).optional().or(z.literal("")),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1, "Quantity must be at least 1").max(999),
      })
    )
    .min(1, "Your cart is empty")
    .max(50),
});

export async function POST(req: NextRequest) {
  try {
    await connectDB();

    const parsed = checkoutSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const err of parsed.error.errors) {
        const path = err.path.join(".");
        fieldErrors[path] = err.message;
      }
      // Surface the first cart/product error at the top level for the UI.
      const first = parsed.error.errors[0];
      return NextResponse.json(badRequest(first?.message ?? "Validation failed", fieldErrors), {
        status: 400,
      });
    }

    const body = parsed.data;

    // Merge duplicate lines defensively (same product twice in one cart).
    const qtyByProduct = new Map<string, number>();
    for (const item of body.items) {
      if (!mongoose.Types.ObjectId.isValid(item.productId)) {
        return NextResponse.json(badRequest("One of the products in your cart is invalid"), {
          status: 400,
        });
      }
      qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    }

    const productIds = Array.from(qtyByProduct.keys()).map((id) => new mongoose.Types.ObjectId(id));
    const products = await StoreProduct.find({ _id: { $in: productIds }, status: "active" });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const lineItems: Array<{
      productId: mongoose.Types.ObjectId;
      name: string;
      price: number;
      quantity: number;
    }> = [];
    let subtotal = 0;

    for (const [productId, quantity] of qtyByProduct.entries()) {
      const product = productMap.get(productId);
      if (!product) {
        return NextResponse.json(badRequest("One of the products in your cart is no longer available"), {
          status: 400,
        });
      }
      if (product.stock < quantity) {
        return NextResponse.json(
          badRequest(
            product.stock === 0
              ? `"${product.name}" is sold out`
              : `Only ${product.stock} left of "${product.name}"`
          ),
          { status: 400 }
        );
      }
      const lineTotal = round2(product.price * quantity);
      subtotal = round2(subtotal + lineTotal);
      lineItems.push({
        productId: product._id,
        name: product.name,
        price: product.price,
        quantity,
      });
    }

    // Order number: WEB-YYYYMMDD-XXXX (time-slice + random suffix, readable on calls).
    const now = new Date();
    const day = now.toISOString().slice(0, 10).replace(/-/g, "");
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const orderNumber = `WEB-${day}-${suffix}`;

    // Decrement stock atomically per line; abort (no partial order) if raced.
    const session = await mongoose.startSession();
    let order: {
      id: string;
      orderNumber: string;
      total: number;
    };
    try {
      await session.withTransaction(async () => {
        for (const [productId, quantity] of qtyByProduct.entries()) {
          const res = await StoreProduct.updateOne(
            { _id: new mongoose.Types.ObjectId(productId), stock: { $gte: quantity } },
            { $inc: { stock: -quantity } },
            { session }
          );
          if (res.modifiedCount === 0) {
            const p = productMap.get(productId);
            throw new Error(
              p && p.stock === 0
                ? `"${p.name}" just sold out`
                : `Not enough stock left for "${p?.name ?? "an item"}"`
            );
          }
        }

        const docs = await StoreOrder.create(
          [
            {
              orderNumber,
              customerName: body.customerName,
              phone: body.phone,
              email: body.email ?? "",
              address: body.address ?? "",
              note: body.note ?? "",
              items: lineItems,
              subtotal,
              total: subtotal,
              status: "pending",
            },
          ],
          { session }
        );
        order = {
          id: docs[0]._id.toString(),
          orderNumber: docs[0].orderNumber,
          total: docs[0].total,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message) {
        return NextResponse.json(badRequest(message), { status: 400 });
      }
      throw err;
    } finally {
      await session.endSession();
    }

    return NextResponse.json(
      {
        success: true,
        data: order!,
        message: "Order placed! We will call you shortly to confirm delivery.",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/store/orders error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
