import { sellerRoute } from "@/lib/seller";

export const GET = sellerRoute("quote", () => ({
  kind: "quote",
  pair: "ETH/USDC",
  note: "demo content returned after an x402 payment",
  served_at: new Date().toISOString(),
}));
