import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { withX402, x402ResourceServer } from "@x402/next";

// Demo x402 seller. Prices come from config/prices.json.

interface PriceConfig {
  network: `${string}:${string}`;
  facilitator_url: string;
  routes: Record<string, { description: string; payTo_env: string; prices: string[] }>;
}

const cfg = (): PriceConfig => JSON.parse(readFileSync(path.join(process.cwd(), "config", "prices.json"), "utf8"));

let server: x402ResourceServer | undefined;
function resourceServer(c: PriceConfig) {
  server ??= new x402ResourceServer(new HTTPFacilitatorClient({ url: c.facilitator_url })).register(
    c.network,
    new ExactEvmScheme(),
  );
  return server;
}

const handlers = new Map<string, (req: NextRequest) => Promise<NextResponse>>();

/** Built on first request so a missing env var fails that request, not the build. */
export function sellerRoute(name: string, content: (req: NextRequest) => unknown) {
  return async (req: NextRequest) => {
    let h = handlers.get(name);
    if (!h) {
      const c = cfg();
      const route = c.routes[name];
      const payTo = process.env[route.payTo_env];
      if (!payTo) return NextResponse.json({ error: `${route.payTo_env} not set` }, { status: 500 });
      h = withX402(
        async (r: NextRequest) => NextResponse.json(content(r)),
        {
          accepts: route.prices.map((price) => ({ scheme: "exact", price, network: c.network, payTo })),
          description: route.description,
          mimeType: "application/json",
        },
        resourceServer(c),
      );
      handlers.set(name, h);
    }
    return h(req);
  };
}
