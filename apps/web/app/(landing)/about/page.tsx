import type { Metadata } from "next";
import { AboutPageClient } from "@/features/landing/components/about-page-client";

export const metadata: Metadata = {
  title: "About",
  description:
    "LYNXD AIOS by Infoportal Tech. Your AI-powered business operations.",
  openGraph: {
    title: "About LYNXD AIOS",
    description:
      "The story behind LYNXD AIOS and why we're building project management for human + agent teams.",
    url: "/about",
  },
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return <AboutPageClient />;
}
