import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PATHS = ['/leads', '/sessions', '/mock-crm', '/sim', '/health'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, 'http://localhost:3001'])),
  },
});
