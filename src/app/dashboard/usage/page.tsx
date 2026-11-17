import type { Metadata } from "next";
import ApiUsage from "@/views/ApiUsage";
import { canonical } from "@/lib/seo";

export const dynamic = "force-dynamic";

/* A protected board surface: indexable only to a signed-in reader, so it is
   kept out of the index while still carrying its canonical for the app. */
export async function generateMetadata(): Promise<Metadata> {
  const url = canonical("/dashboard/usage");
  const description = "API rate-limit consumption, traffic over time and key management for this cyrus.ai deployment.";
  return {
    title: "API usage · Board",
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: true },
    openGraph: { title: "API usage · cyrus.ai", description, url },
  };
}

export default function Page() {
  return <ApiUsage />;
}
