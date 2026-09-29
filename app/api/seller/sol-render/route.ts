import { sellerRoute } from "@/lib/seller";

export const GET = sellerRoute("sol-render", () => ({
  kind: "render",
  note: "demo content returned after an x402 payment on Solana devnet",
  served_at: new Date().toISOString(),
}));
