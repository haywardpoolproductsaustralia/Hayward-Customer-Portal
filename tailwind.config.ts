import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        wave: '#0EA5E9',     // primary brand - bright pool-water blue
        deep: '#075985',     // headers, high-emphasis text on light bg
        sunset: '#FB5607',   // CTA accent - warm punchy contrast
        splash: '#0D9488',   // in-stock / success
        foam: '#F0F9FF',     // page background - light blue tint
        amber: '#F59E0B',    // backorder / hold
        coral: '#E11D48',    // cancelled / error
        ink: '#0F172A',      // body text
      },
      fontFamily: {
        display: ['var(--font-outfit)'],
        body: ['var(--font-inter)'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px rgba(15, 23, 42, 0.06)',
        glow: '0 0 0 1px rgba(14, 165, 233, 0.1), 0 8px 24px rgba(14, 165, 233, 0.15)',
      },
    },
  },
  plugins: [],
};
export default config;
