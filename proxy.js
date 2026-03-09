import express from "express";
import cors from "cors";
import https from "https";
import http from "http";
import { URL } from "url";

const app = express();
app.use(cors());

const BASE = "https://api.archivizer.com";

app.use("/archivizer", (req, res) => {
  const target = new URL(BASE + req.path);
  const method = req.headers["x-real-method"] || req.method;

  const options = {
    hostname: target.hostname,
    port: 443,
    path: target.pathname + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    method,
    headers: {
      ...req.headers,
      host: target.hostname,
    },
  };

  delete options.headers["x-real-method"];

  const proxy = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on("error", (e) => {
    res.status(502).json({ error: e.message });
  });

  req.pipe(proxy);
});

app.listen(3001, () => console.log("Proxy running on http://localhost:3001"));
