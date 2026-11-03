import type { Metadata } from "next";
import "./globals.css";
import { ToastContainer } from "@/components/ui/toast";
import { getLocale } from "@/i18n/server";
import { getDictionary } from "@/i18n/dictionaries";
import { I18nProvider } from "@/i18n/client";
import { LOCALE_META } from "@/i18n/config";
import { ServiceWorkerRegister } from "@/components/sw-register";

// Fonts are resolved from the local system stack (see globals.css). The app
// must boot, build and serve with no internet: `next/font/google` downloads
// from fonts.googleapis.com at build/dev time, which left every page blank on
// an offline shop PC.

export const metadata: Metadata = {
  title: "POS Dashboard",
  description: "Retail Point of Sale system",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const meta = LOCALE_META[locale];

  return (
    <html lang={locale} dir={meta.dir}>
      <body className="font-sans antialiased">
        <I18nProvider locale={locale} dict={dict}>
          {children}
          <ToastContainer />
          <ServiceWorkerRegister />
        </I18nProvider>
      </body>
    </html>
  );
}
