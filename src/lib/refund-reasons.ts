/**
 * Common refund reasons, shared by the POS refund/exchange dialog and the
 * Returns module so a cashier always picks from the same list.
 *
 * The first entry is the prefilled default; "other" reveals a free-text box.
 */
export const REFUND_REASONS: Array<{ value: string; label: string }> = [
  { value: "customer_returned", label: "Customer returned it — changed their mind" },
  { value: "customer_returned_wrong", label: "Customer returned it — wrong item, size or color" },
  { value: "defective", label: "Defective or damaged product" },
  { value: "not_as_described", label: "Not as described" },
  { value: "expired", label: "Expired or near expiry" },
  { value: "duplicate", label: "Duplicate purchase" },
  { value: "other", label: "Other reason…" },
];

export const OTHER_REASON = "other";
