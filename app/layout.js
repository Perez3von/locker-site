import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata = {
  title: "Locker",
  description: "Collect package IDs and send them to WIP when connected.",
  applicationName: "Locker",
  appleWebApp: { capable: true, title: "Locker", statusBarStyle: "default" },
  icons: { icon: [{ url: "/icon-192.png", sizes: "192x192" }], apple: "/apple-icon.png" },
};

export const viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
