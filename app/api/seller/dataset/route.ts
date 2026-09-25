import { sellerRoute } from "@/lib/seller";

export const GET = sellerRoute("dataset", () => ({
  kind: "dataset",
  rows: 100,
  note: "demo content returned after an x402 payment",
  served_at: new Date().toISOString(),
}));
