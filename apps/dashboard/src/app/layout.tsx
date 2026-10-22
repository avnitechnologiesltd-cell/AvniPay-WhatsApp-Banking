import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Avni Dashboard",
  description: "Banking administration and support for the Bank's staff",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const RootLayout = ({ children }: { children: ReactNode }): ReactNode => (
  <html lang="en">
    <body
      style={{
        margin: 0,
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        lineHeight: 1.5,
      }}
    >
      {children}
    </body>
  </html>
);

export default RootLayout;
