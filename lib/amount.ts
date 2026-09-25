// USDC-style fixed-point amounts. Policy files use decimal strings ("0.50");
// x402 payment requirements use atomic-unit integer strings ("500000").

export function toAtomic(decimal: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new Error(`invalid decimal amount: ${decimal}`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`too many decimals in ${decimal}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function fromAtomic(atomic: bigint | string, decimals: number): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
