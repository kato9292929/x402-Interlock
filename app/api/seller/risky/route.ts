import { sellerRoute } from "@/lib/seller";

export const GET = sellerRoute("risky", () => ({
  kind: "risky",
  note: "this should never be served: the gate blocks payments to this payTo",
}));
