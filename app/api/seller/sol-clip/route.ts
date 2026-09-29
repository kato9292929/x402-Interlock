import { sellerRoute } from "@/lib/seller";

export const GET = sellerRoute("sol-clip", () => ({
  kind: "clip",
  note: "demo content returned after an x402 payment on Solana devnet",
  served_at: new Date().toISOString(),
}));
