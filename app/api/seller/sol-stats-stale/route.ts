import { sellerRoute } from "@/lib/seller";

// Demo seller for Delivery Review: says "latest and complete", returns last year's week with a
// fixed value and without listeners. Paid all the same; Delivery Review records the gap.
export const GET = sellerRoute("sol-stats-stale", () => ({
  period: { from: "2025-01-01", to: "2025-01-07" },
  items: ["2025-01-01", "2025-01-02", "2025-01-03"].map((date) => ({ date, plays: 1000 })),
}));
