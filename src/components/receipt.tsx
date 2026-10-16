import { money } from "@/lib/currency";

/**
 * Printable receipt used by the POS (online + offline) and rendered only when
 * the browser prints — `.print-only` is `display: none` on screen and becomes
 * visible inside the `@media print` block in globals.css.
 */
export interface ReceiptItem {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  tax: number;
  total: number;
}

export interface ReceiptData {
  /** Local or server invoice/reference number. */
  invoiceNumber: string;
  createdAt: string;
  storeName: string;
  address: string;
  phone: string;
  cashierName: string;
  customerName: string | null;
  items: ReceiptItem[];
  subtotal: number;
  discountAmount: number;
  tax: number;
  total: number;
  paidAmount: number;
  changeAmount: number;
  payments: Array<{ method: string; amount: number }>;
  /** True when the sale was taken offline and is pending synchronization. */
  offline?: boolean;
}

export function PrintableReceipt({ data }: { data: ReceiptData }) {
  return (
    <div className="print-only mx-auto max-w-[80mm] bg-white p-4 text-[12px] leading-relaxed text-black">
      <div className="text-center">
        <p className="text-base font-bold uppercase">{data.storeName || "POS Store"}</p>
        {data.address && <p>{data.address}</p>}
        {data.phone && <p>Tel: {data.phone}</p>}
        <p className="mt-2 font-bold">SALES RECEIPT</p>
        {data.offline && (
          <p className="mt-1 border border-black px-1 py-0.5 text-[11px] font-bold">
            OFFLINE — PENDING SYNC
          </p>
        )}
      </div>

      <div className="mt-3 border-y border-dashed border-black py-2 text-[11px]">
        <div className="flex justify-between">
          <span>Invoice:</span>
          <span className="font-mono font-bold">{data.invoiceNumber}</span>
        </div>
        <div className="flex justify-between">
          <span>Date:</span>
          <span>{new Date(data.createdAt).toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Cashier:</span>
          <span>{data.cashierName}</span>
        </div>
        <div className="flex justify-between">
          <span>Customer:</span>
          <span>{data.customerName ?? "Walk-in"}</span>
        </div>
      </div>

      <table className="mt-2 w-full text-[11px]">
        <thead>
          <tr className="border-b border-dashed border-black text-left">
            <th>Item</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Price</th>
            <th className="text-right">Amt</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, i) => (
            <tr key={`${item.sku}-${i}`} className="align-top">
              <td>
                {item.name}
                {item.discount > 0 && <span className="block text-[10px]">disc −{money(item.discount)}</span>}
                {item.tax > 0 && <span className="block text-[10px]">tax {money(item.tax)}</span>}
              </td>
              <td className="text-right">{item.quantity}</td>
              <td className="text-right">{money(item.unitPrice)}</td>
              <td className="text-right">{money(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-2 space-y-0.5 border-t border-dashed border-black pt-2 text-[11px]">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{money(data.subtotal)}</span>
        </div>
        {data.discountAmount > 0 && (
          <div className="flex justify-between">
            <span>Discount</span>
            <span>−{money(data.discountAmount)}</span>
          </div>
        )}
        {data.tax > 0 && (
          <div className="flex justify-between">
            <span>Tax</span>
            <span>{money(data.tax)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-bold">
          <span>TOTAL</span>
          <span>{money(data.total)}</span>
        </div>
        {data.payments.map((p, i) => (
          <div key={i} className="flex justify-between capitalize">
            <span>Paid ({p.method})</span>
            <span>{money(p.amount)}</span>
          </div>
        ))}
        {data.changeAmount > 0 && (
          <div className="flex justify-between font-bold">
            <span>CHANGE</span>
            <span>{money(data.changeAmount)}</span>
          </div>
        )}
      </div>

      <p className="mt-3 text-center text-[10px]">Thank you for shopping with us!</p>
      {data.offline && (
        <p className="mt-1 text-center text-[10px] font-semibold">
          Offline sale — will synchronize when the connection returns.
        </p>
      )}
    </div>
  );
}
