import { sellerRoute } from "@/lib/seller";

export const GET = sellerRoute("report", () => ({
  kind: "report",
  title: "Weekly market report",
  note: "demo content returned after an x402 payment",
  served_at: new Date().toISOString(),
}));
