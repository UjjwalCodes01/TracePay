import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs on :4000; in production VITE_API_BASE_URL points at Render.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
