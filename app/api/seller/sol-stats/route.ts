import { sellerRoute } from "@/lib/seller";
import { statsPeriod } from "@/lib/demo-stats";

// Demo seller for Delivery Review: answers for the period asked for, with every field.
export const GET = sellerRoute("sol-stats", (req) => {
  const { from, to, days } = statsPeriod(req);
  return { period: { from, to }, items: days.map((date, i) => ({ date, plays: 1200 + ((i * 337) % 500), listeners: 300 + ((i * 89) % 120) })) };
});
