import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs on :4000. In production vercel.json rewrites /api/* to
    // the Render API on the same origin, so session cookies stay first-party.
    // VITE_API_PROXY lets the browser tests point the app at their own API instance.
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:4000' },
  },
  // `vite preview` (the browser tests) uses the same proxy.
  preview: { proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:4000' } },
});
