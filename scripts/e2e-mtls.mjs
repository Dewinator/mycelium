// E2E: HTTPS+mTLS gegen die eigene Federation-Endpoint /federation/whoami.
// Verwendet das eigene Host-Cert als Client-Cert (Self-Loop-Test).
import https from "node:https";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEYS = join(homedir(), ".openclaw", "keys");
const cert = readFileSync(join(KEYS, "host.crt"));
const key  = readFileSync(join(KEYS, "host.key"));

const HOST = process.env.FED_HOST || "127.0.0.1";
const PORT = Number(process.env.FED_PORT || 8788);

function call(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, port: PORT, path, method: "GET",
      cert, key,
      rejectUnauthorized: false,    // server's cert is self-signed
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

console.log("=== whoami ===");
const r = await call("/federation/whoami");
console.log("status:", r.status);
console.log(r.body);
