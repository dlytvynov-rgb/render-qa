import { app, BrowserWindow, ipcMain, dialog } from "electron";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3333;

function startServer() {
  const srv = express();

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
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.cjs") },
  });

  win.loadURL(`http://localhost:${PORT}`);
  win.setMenuBarVisibility(false);
}

ipcMain.handle("save-pdf", async (event, html) => {
  const timestamp = new Date().toISOString().slice(0, 10);
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: "Зберегти QA Report",
    defaultPath: path.join(app.getPath("desktop"), `RenderQA_Report_${timestamp}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: false };
  const hidden = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await hidden.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const pdfBuf = await hidden.webContents.printToPDF({ printBackground: true, pageSize: "A4", marginsType: 1 });
  hidden.close();
  fs.writeFileSync(filePath, pdfBuf);
  return { ok: true, path: filePath };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
