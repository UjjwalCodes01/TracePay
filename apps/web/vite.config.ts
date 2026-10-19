import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs on :4000. In production vercel.json rewrites /api/* to
    // the Render API on the same origin, so session cookies stay first-party.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
