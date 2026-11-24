import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Secret Santa — საიდუმლო საჩუქარი", description: "გაათამაშე საიდუმლო საჩუქრები ექვს მეგობარს შორის." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ka"><body>{children}</body></html>;
}
