import { sellerRoute } from "@/lib/seller";
import { statsPeriod } from "@/lib/demo-stats";

// Demo seller for Delivery Review: takes the payment and returns no rows.
export const GET = sellerRoute("sol-stats-empty", (req) => {
  const { from, to } = statsPeriod(req);
  return { period: { from, to }, items: [] };
});
