// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'client',
    server: {
        port: 5173,
        proxy: {
            '/socket.io': {
                target: 'http://localhost:3000',
                ws: true,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
    },
});
