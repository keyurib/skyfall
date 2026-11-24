import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "SkyFall — Mission Visualization",
  description:
    "Conceptual visualization of NASA's SkyFall mission: three autonomous Mars helicopters, released mid-air during descent, search for subsurface ice.",
};

export const viewport: Viewport = {
  themeColor: "#05060A",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
