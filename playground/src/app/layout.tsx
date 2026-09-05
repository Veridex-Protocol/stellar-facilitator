import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Veridex x402 Sandbox - Live Stellar Testnet Playground",
  description:
    "Interactive testnet sandbox for canonical x402 payments on Stellar: step-by-step settlement, decoded wire traffic, RFC 8785 receipt verification, and 9 live attack probes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
