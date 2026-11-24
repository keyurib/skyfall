// Typography (DESIGN.md): display Space Grotesk, body Inter, telemetry JetBrains Mono,
// plus Michroma (provided in references/, OFL) for the SKYFALL wordmark only.
// next/font self-hosts every file at build time: no runtime requests to Google.
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import localFont from "next/font/local";

export const displayFont = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-display",
  display: "swap",
});

export const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const wordmarkFont = localFont({
  src: "./fonts/Michroma-Regular.ttf",
  weight: "400",
  variable: "--font-wordmark",
  display: "swap",
});

export const fontVariables = [displayFont, bodyFont, monoFont, wordmarkFont].map((font) => font.variable).join(" ");
