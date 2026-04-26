#!/usr/bin/env node
// sign-jwt.mjs — minimaler HS256-JWT-Signer fuer PostgREST.
// Aufruf: JWT_SECRET=<secret> node sign-jwt.mjs [role]
//   role default: service_role
import crypto from "node:crypto";

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error("JWT_SECRET env required");
  process.exit(2);
}

const role = process.argv[2] || "service_role";
const tenYears = 10 * 365 * 86400;
const now = Math.floor(Date.now() / 1000);

const b64url = (b) => Buffer.from(b).toString("base64url");
const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + tenYears }));
const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");

console.log(`${header}.${payload}.${sig}`);
