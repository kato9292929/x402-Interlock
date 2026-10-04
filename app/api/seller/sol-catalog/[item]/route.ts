import { NextResponse, type NextRequest } from "next/server";
import { catalogItem, sellerHandler } from "@/lib/seller";

// Demo catalog for the spec/07 section 4 check: many small paid endpoints with different
// descriptions, so Spend Guard can be compared with the owner's own judgement.
export async function GET(req: NextRequest, ctx: RouteContext<"/api/seller/sol-catalog/[item]">) {
  const { item } = await ctx.params;
  const it = catalogItem(item);
  if (!it) return NextResponse.json({ error: "unknown item" }, { status: 404 });
  return sellerHandler(`catalog:${item}`, { description: it.description, prices: [it.price], payTo_env: "SELLER_SOLANA_PAY_TO", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", facilitator_url: "https://facilitator.payai.network" }, () => it.body)(req);
}
