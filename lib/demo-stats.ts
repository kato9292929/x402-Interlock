import type { NextRequest } from "next/server";

/** The requested period (?from=&to=, ISO dates; default: the last 7 days) and its days. */
export function statsPeriod(req: NextRequest) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const from = req.nextUrl.searchParams.get("from") ?? day(new Date(today.getTime() - 6 * 86400_000));
  const to = req.nextUrl.searchParams.get("to") ?? day(today);
  const days: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to) && days.length < 31; t += 86400_000) days.push(day(new Date(t)));
  return { from, to, days };
}
