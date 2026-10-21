/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Loaded at runtime by lib/containers (PDF text extraction, Outlook .msg unpacking) — keep them out of the bundler.
    serverComponentsExternalPackages: ["pdfjs-dist", "@kenjiuno/msgreader"],
  },
};
module.exports = nextConfig;
