import type { Metadata } from "next"
import { Plus_Jakarta_Sans } from "next/font/google"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./globals.css"

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  display: "swap",
})

export const metadata: Metadata = {
  title: "SHILL — Get some money where your mouth is",
  description:
    "In a world where nothing matters more than being heard — SHILL turns callouts into live payout rounds.",
  openGraph: {
    title: "SHILL",
    description: "Call it. Get noticed. Get paid.",
    images: [{ url: "/brand/logo.png?v=3", width: 1200, height: 1200 }],
  },
  icons: {
    icon: [{ url: "/brand/favicon.png?v=3", type: "image/png" }],
    apple: [{ url: "/brand/apple-touch-icon.png?v=3", type: "image/png" }],
  },
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${jakarta.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans text-foreground">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
