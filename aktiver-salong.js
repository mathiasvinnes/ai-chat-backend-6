#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  AKTIVER SALONG  – kjøres lokalt av deg (eier), ikke på Render.
//
//  Bruk:
//    1. Lagre salongens config som en JSON-fil (f.eks. salong.json), eller bruk
//       JSON-en du fikk på e-post fra onboarding-skjemaet.
//    2. Kjør:
//         SERVER_URL=https://din-app.onrender.com \
//         ADMIN_TOKEN=din-hemmelige-token \
//         node aktiver-salong.js salong.json
//
//  Skriptet kaller /provision med admin-token og skriver ut salongens URL og
//  dashboard-nøkkel. Salongen er live umiddelbart – ingen ny Render-instans.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";

const SERVER_URL  = process.env.SERVER_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const fil         = process.argv[2];

if (!SERVER_URL || !ADMIN_TOKEN) {
  console.error("Mangler SERVER_URL eller ADMIN_TOKEN (miljøvariabler).");
  process.exit(1);
}
if (!fil) {
  console.error("Bruk: node aktiver-salong.js <config.json>");
  process.exit(1);
}

let konfig;
try {
  konfig = JSON.parse(readFileSync(fil, "utf-8"));
} catch (err) {
  console.error("Kunne ikke lese JSON-filen:", err.message);
  process.exit(1);
}

const res = await fetch(`${SERVER_URL}/provision`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${ADMIN_TOKEN}`
  },
  body: JSON.stringify({ konfig })
});

const data = await res.json();
if (!res.ok || !data.ok) {
  console.error("Feil:", data.feil || res.status);
  process.exit(1);
}

console.log("\n✅ Salong aktivert!");
console.log("   Slug:      ", data.slug);
console.log("   Nettside:  ", data.url);
console.log("   Dashboard-nøkkel:", data.nokkel);
console.log("\n   Gi dashboard-nøkkelen til salongen (de logger inn på /dashboard).\n");