import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    proxy: {
      "/archivizer-static": {
        target: "https://static.archivizer.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/archivizer-static/, ""),
      },
      "/archivizer": {
        target: "https://api.archivizer.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/archivizer/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            const realMethod = req.headers["x-real-method"];
            if (realMethod) {
              proxyReq.method = realMethod;
              proxyReq.removeHeader("x-real-method");
            }
          });
        },
      },
    },
  },
})
