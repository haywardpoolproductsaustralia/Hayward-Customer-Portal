/** @type {import('next').NextConfig} */
const PDF_WORKER = ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"];
const nextConfig = {
  experimental: {
    // Loaded at runtime by lib/containers (PDF text extraction, Outlook .msg unpacking) — keep them out of the bundler.
    serverComponentsExternalPackages: ["pdfjs-dist", "@kenjiuno/msgreader"],
    // pdfjs imports its worker dynamically, so Vercel's file tracing misses it ("Setting up fake worker failed:
    // Cannot find module …/pdf.worker.mjs"). Ship it with every function that parses container PDFs.
    outputFileTracingIncludes: {
      "/api/containers/upload": PDF_WORKER,
      "/api/containers/ingest": PDF_WORKER,
      "/api/containers/refresh": PDF_WORKER,
    },
  },
};
module.exports = nextConfig;
