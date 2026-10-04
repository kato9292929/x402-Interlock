import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { withX402, x402ResourceServer } from "@x402/next";

// Demo x402 seller. Prices come from config/prices.json.

interface PriceConfig {
  network: `${string}:${string}`;
  facilitator_url: string;
  routes: Record<string, { description: string; payTo_env: string; prices: string[]; network?: `${string}:${string}`; facilitator_url?: string }>;
}

const cfg = (): PriceConfig => JSON.parse(readFileSync(path.join(process.cwd(), "config", "prices.json"), "utf8"));

// One resource server per (facilitator, network): Base via x402.org, Solana via PayAI.
const servers = new Map<string, x402ResourceServer>();
function resourceServer(network: `${string}:${string}`, facilitatorUrl: string) {
  const key = `${facilitatorUrl} ${network}`;
  let s = servers.get(key);
  if (!s) {
    const scheme = network.startsWith("solana:") ? new ExactSvmScheme() : new ExactEvmScheme();
    s = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })).register(network, scheme);
    servers.set(key, s);
  }
  return s;
}

const handlers = new Map<string, (req: NextRequest) => Promise<NextResponse>>();

type Route = PriceConfig["routes"][string];

/** Built on first request so a missing env var fails that request, not the build. */
export function sellerRoute(name: string, content: (req: NextRequest) => unknown) {
  return (req: NextRequest) => sellerHandler(name, cfg().routes[name], content)(req);
}

export function sellerHandler(name: string, route: Route, content: (req: NextRequest) => unknown) {
  return async (req: NextRequest) => {
    let h = handlers.get(name);
    if (!h) {
      const c = cfg();
      const payTo = process.env[route.payTo_env];
      if (!payTo) return NextResponse.json({ error: `${route.payTo_env} not set` }, { status: 500 });
      h = withX402(
        async (r: NextRequest) => NextResponse.json(content(r)),
        {
          accepts: route.prices.map((price) => ({ scheme: "exact", price, network: route.network ?? c.network, payTo })),
          description: route.description,
          mimeType: "application/json",
        },
        resourceServer(route.network ?? c.network, route.facilitator_url ?? c.facilitator_url),
      );
      handlers.set(name, h);
    }
    return h(req);
  };
}

interface CatalogItem {
  price: string;
  description: string;
  body: unknown;
}

/** An item of config/eval-catalog.json, or undefined. */
export function catalogItem(slug: string): CatalogItem | undefined {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return undefined;
  const items = (JSON.parse(readFileSync(path.join(process.cwd(), "config", "eval-catalog.json"), "utf8")) as { items: Record<string, CatalogItem> }).items;
  return Object.hasOwn(items, slug) ? items[slug] : undefined;
}
