import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "x402 Interlock",
  description: "A gate in front of every x402 payment: Intercepta screening, fixed rules, and World ID owner approval.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">x402 Interlock</Link>
          <span className="muted">screen → rules → human → sign</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
