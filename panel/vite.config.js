import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El panel se buildea a ../public/panel, y routes/panelStatic.js (en el
// backend) sirve esa carpeta bajo /panel. Así todo el proyecto sigue
// siendo un solo deploy de Vercel: la API y el panel viven en el mismo
// dominio, sin CORS ni configuración extra.
export default defineConfig({
  plugins: [react()],
  base: '/panel/',
  build: {
    outDir: '../public/panel',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
    },
  },
});