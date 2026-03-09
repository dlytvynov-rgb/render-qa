import { app, BrowserWindow } from "electron";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3333;

function startServer() {
  const srv = express();

  // Static files proxy (must be before /archivizer)
  srv.use("/archivizer-static", createProxyMiddleware({
    target: "https://static.archivizer.com",
    changeOrigin: true,
    pathRewrite: { "^/archivizer-static": "" },
  }));

  // API proxy with x-real-method support
  srv.use("/archivizer", createProxyMiddleware({
    target: "https://api.archivizer.com",
    changeOrigin: true,
    pathRewrite: { "^/archivizer": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        const realMethod = req.headers["x-real-method"];
        if (realMethod) {
          proxyReq.method = realMethod;
          proxyReq.removeHeader("x-real-method");
        }
      },
    },
  }));

  // Serve built app
  const distPath = path.join(__dirname, "../dist");
  srv.use(express.static(distPath));
  srv.use((_, res) => res.sendFile(path.join(distPath, "index.html")));

  return new Promise(resolve => {
    const server = http.createServer(srv);
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

async function createWindow() {
  await startServer();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Render QA",
    webPreferences: { contextIsolation: true },
  });

  win.loadURL(`http://localhost:${PORT}`);
  win.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
