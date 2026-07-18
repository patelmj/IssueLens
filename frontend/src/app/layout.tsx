import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = {
  title: "IssueLens",
  description: "Developer-centric intelligence dashboard over GitHub Issues",
};

const modeScript = `try{var m=localStorage.getItem("issuelens-mode");if(m==="light"||m==="dark")document.documentElement.setAttribute("data-mode",m)}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-mode="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: modeScript }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
