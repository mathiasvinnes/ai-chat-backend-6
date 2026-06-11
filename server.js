import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { webcrypto as crypto } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════════════════════════════════
//  MULTI-TENANT AI-CHATBOT FOR FRISØRSALONGER
//  Én server betjener mange salonger. Hver salong identifiseres med en "slug".
//  Config lastes fra Supabase-tabellen `salonger`, med lokal config.json som
//  fallback for demo/utvikling. Ingen ny Render-instans per salong.
// ════════════════════════════════════════════════════════════════════════════

// ── Miljøvariabler ────────────────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SENDGRID_KEY     = process.env.SENDGRID_KEY;
const EPOST_FRA        = process.env.EPOST_FRA || "mathias.s.vinnes@gmail.com"; // SendGrid verifisert avsender
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN;
const CAL_BASE         = process.env.CAL_BASE || "https://api.cal.com/v2";
// Standard-slug brukt når ingen tenant kan utledes (f.eks. lokal demo).
const DEFAULT_SLUG     = process.env.DEFAULT_SLUG || "demo";
// Basisdomene for subdomene-ruting, f.eks. "ai-salong.no" → kunde.ai-salong.no
const BASE_DOMAIN      = process.env.BASE_DOMAIN || "";
// Supabase Storage-bucket for opplastede salong-bilder (må være public)
const BILDE_BUCKET     = process.env.BILDE_BUCKET || "salong-bilder";

if (!OPENAI_API_KEY) console.warn("[ADVARSEL] OPENAI_API_KEY mangler – chat vil ikke fungere");
if (!SUPABASE_URL || !SUPABASE_KEY) console.warn("[ADVARSEL] Supabase mangler – bruker kun lokal config.json");
if (!ADMIN_TOKEN) console.warn("[ADVARSEL] ADMIN_TOKEN mangler – /provision og admin-endepunkter avvises");

// ── Lokal fallback-config (demo) ───────────────────────────────────────────────
let LOKAL_CONFIG = null;
try {
  if (process.env.CONFIG_JSON) {
    LOKAL_CONFIG = JSON.parse(process.env.CONFIG_JSON);
    console.log("[CONFIG] Lokal fallback lastet fra CONFIG_JSON");
  } else {
    LOKAL_CONFIG = JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf-8"));
    console.log("[CONFIG] Lokal fallback lastet fra config.json");
  }
} catch (err) {
  console.warn("[CONFIG] Ingen lokal config.json funnet:", err.message);
}

// ── Tenant-cache ────────────────────────────────────────────────────────────
// Unngå et Supabase-kall på hver forespørsel. Cache i 5 min per slug.
const tenantCache = new Map(); // slug -> { config, hentet }
const TENANT_TTL  = 5 * 60 * 1000;

function normaliserSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[å]/g, "a")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Henter salong-config fra Supabase (med cache). Returnerer null hvis ukjent.
async function hentTenant(slug) {
  const renSlug = normaliserSlug(slug);
  if (!renSlug) return null;

  const cached = tenantCache.get(renSlug);
  if (cached && Date.now() - cached.hentet < TENANT_TTL) return cached.config;

  // Lokal demo-slug: bruk config.json + Cal-felter fra miljøvariabler
  if (renSlug === normaliserSlug(DEFAULT_SLUG) && LOKAL_CONFIG) {
    const config = {
      ...LOKAL_CONFIG,
      slug: renSlug,
      calApiKey: LOKAL_CONFIG.calApiKey || process.env.CAL_API_KEY || "",
      calEventId: Number(LOKAL_CONFIG.calEventId || process.env.CAL_EVENT_TYPE_ID || 0)
    };
    tenantCache.set(renSlug, { config, hentet: Date.now() });
    return config;
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    // Ingen database: kun lokal config tilgjengelig
    if (LOKAL_CONFIG) {
      const config = {
        ...LOKAL_CONFIG,
        slug: renSlug,
        calApiKey: LOKAL_CONFIG.calApiKey || process.env.CAL_API_KEY || "",
        calEventId: Number(LOKAL_CONFIG.calEventId || process.env.CAL_EVENT_TYPE_ID || 0)
      };
      return config;
    }
    return null;
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/salonger?slug=eq.${encodeURIComponent(renSlug)}&aktiv=eq.true&select=*`,
      { headers: supaHeaders() }
    );
    const rader = await r.json();
    if (!Array.isArray(rader) || rader.length === 0) {
      tenantCache.set(renSlug, { config: null, hentet: Date.now() });
      return null;
    }
    // Supabase lagrer config-feltene; konverter rad → config-objekt
    const rad = rader[0];
    const config = radTilConfig(rad);
    tenantCache.set(renSlug, { config, hentet: Date.now() });
    return config;
  } catch (err) {
    console.error(`[TENANT] Kunne ikke hente '${renSlug}':`, err.message);
    return null;
  }
}

// Tøm cache for én slug (etter oppdatering via /provision)
function tomTenantCache(slug) {
  tenantCache.delete(normaliserSlug(slug));
}

function supaHeaders(extra = {}) {
  return {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

// Konverter en Supabase-rad til config-objektet resten av koden forventer.
// Vi lagrer hele config-blobben i en `config`-kolonne (jsonb) for enkelhet,
// men støtter også flate kolonner som fallback.
function radTilConfig(rad) {
  const base = (rad.config && typeof rad.config === "object") ? rad.config : rad;
  return {
    slug:         rad.slug,
    bedrift:      base.bedrift      || "",
    bransje:      base.bransje      || "frisørsalong",
    tone:         base.tone         || "vennlig og profesjonell",
    sprakOgLand:  base.sprakOgLand  || "norsk",
    velkomst:     base.velkomst     || "",
    adresse:      base.adresse      || "",
    telefon:      base.telefon      || "",
    epost:        base.epost        || "",
    bookinglink:  base.bookinglink  || "",
    tjenester:    base.tjenester    || [],
    priser:       base.priser       || [],
    apningstider: base.apningstider || {},
    faq:          base.faq          || {},
    farge:        base.farge        || "#b8924a",
    sekundarfarge: base.sekundarfarge || "#8a6a2a",
    bakgrunn:     base.bakgrunn     || "#f5f0e8",
    beskrivelse:  base.beskrivelse  || "",
    usp:          base.usp          || [],
    produkter:    base.produkter    || "",
    erfaringAar:  base.erfaringAar  || "",
    ansatte:      base.ansatte      || "",
    kunder:       base.kunder       || "",
    bildeHero:    base.bildeHero    || "",
    bildeOm:      base.bildeOm      || "",
    ekstraInfo:   base.ekstraInfo   || "",
    // Per-salong Cal.com-konfig (kan variere mellom salonger)
    calApiKey:    rad.cal_api_key   || base.calApiKey   || process.env.CAL_API_KEY || "",
    calEventId:   Number(rad.cal_event_id || base.calEventId || process.env.CAL_EVENT_TYPE_ID || 0)
  };
}

// ── Tenant-resolusjon per forespørsel ──────────────────────────────────────────
// Rekkefølge: ?salong=slug  →  X-Salong-header  →  subdomene  →  DEFAULT_SLUG
function utledSlug(req) {
  if (req.query && req.query.salong) return normaliserSlug(req.query.salong);
  const header = req.headers["x-salong"];
  if (header) return normaliserSlug(header);

  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (BASE_DOMAIN && host.endsWith("." + BASE_DOMAIN)) {
    const sub = host.slice(0, host.length - BASE_DOMAIN.length - 1);
    if (sub && sub !== "www") return normaliserSlug(sub);
  }
  return normaliserSlug(DEFAULT_SLUG);
}

// Middleware som legger req.tenant på forespørselen, eller svarer 404.
async function krevTenant(req, res, next) {
  const slug = utledSlug(req);
  const config = await hentTenant(slug);
  if (!config || !config.bedrift) {
    return res.status(404).json({ error: "Ukjent salong.", slug });
  }
  req.tenant = config;
  req.tenantSlug = slug;
  next();
}

// ── System-prompt (bygges per salong) ──────────────────────────────────────────
function byggSystemPrompt(config) {
  const priser = (config.priser || []).join("\n  - ") || "Kontakt salongen for priser";
  const tjenester = (config.tjenester || []).join(", ") || "";
  const apningstider = Object.entries(config.apningstider || {})
    .map(([dag, tid]) => `  ${dag}: ${tid}`)
    .join("\n");
  const faqLinjer = Object.entries(config.faq || {})
    .map(([, svar]) => `  - ${svar}`)
    .join("\n");

  return `Du er en ${config.tone || "vennlig og profesjonell"} kundeserviceassistent for ${config.bedrift}, en ${config.bransje}.

Retningslinjer:
- Svar alltid pa ${config.sprakOgLand || "norsk"}, kort og konkret (maks 3 setninger).
- Var varm og imotekommende - bruk kundens navn hvis du kjenner det.
- Hvis sporsmalet ikke er relevant for ${config.bransje}, avvis hoflig og hold deg til temaet.
- Svar alltid fra informasjonen nedenfor. Hvis du ikke vet svaret, be kunden ringe eller sende e-post.
- Hvis du ikke kjenner kundens navn og samtalen er i gang (ikke første melding), kan du spørre høflig og naturlig om navnet EN gang. Eksempel: "Forresten, hva heter du?". Gjør det kun hvis det føles naturlig, ikke som et skjema.
- Når kunden oppgir navnet sitt, bruk det i svaret og husk det resten av samtalen.
- Du KAN vise ledige tider - disse hentes automatisk fra kalenderen og vises under svaret ditt.
- Du KAN IKKE bekrefte, reservere eller booke tider direkte - kunden klikker pa en ledig tid.

REGLER FOR [BOOK]-TAG:
- Avslutt med [BOOK] pa en HELT EGEN LINJE kun nar kunden eksplisitt vil bestille, se ledige tider, eller spor om booking.
- Eksempler der du SKAL bruke [BOOK]:
  * "kan jeg bestille time?" -> "Selvfolgelig! La meg sjekke ledige tider.\n[BOOK]"
  * "er det noen ledige tider?" -> "Jeg sjekker for deg!\n[BOOK]"
  * "vil booke pa fredag" -> "Jeg sjekker fredag for deg!\n[BOOK]"
- Eksempler der du IKKE skal bruke [BOOK]:
  * "er dere apne pa lordag?" -> svar med apningstider, ingen [BOOK]
  * "hva koster en klipp?" -> svar med pris, ingen [BOOK]
  * "takk" / "ok" / "greit" -> vanlig svar, ingen [BOOK]
- VIKTIG: Hvis kunden spor om ledige tider og du IKKE har vist tider i denne samtalen, bruk ALLTID [BOOK]. Ikke si "tidene over" hvis ingen tider er vist.
- Skriv ALDRI "her er ledige tider" - du vet ikke om det finnes tider enna.
- Skriv ALDRI at du ikke har tilgang til kalenderen.
- Skriv ALDRI at du har booket - kunden ma klikke selv.

Kontaktinformasjon:
- Adresse: ${config.adresse || "Ikke oppgitt"}
- Telefon: ${config.telefon || "Ikke oppgitt"}
- E-post: ${config.epost || "Ikke oppgitt"}

Tjenester vi tilbyr: ${tjenester}

Priser:
  - ${priser}

Apningstider:
${apningstider}

Vanlige sporsmal og svar (bruk disse nar relevant):
${faqLinjer}`;
}

// ── Supabase: logging ───────────────────────────────────────────────────────
async function loggSamtale({ slug, bedrift, navn, melding, svar, bookingVist }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/samtaler`, {
      method: "POST",
      headers: supaHeaders({ "Prefer": "return=minimal" }),
      body: JSON.stringify({
        slug, bedrift,
        navn: navn || "Ukjent",
        melding, svar,
        booking_vist: bookingVist
      })
    });
  } catch (err) {
    console.error("[FEIL] loggSamtale:", err.message);
  }
}

// ── Cal.com ─────────────────────────────────────────────────────────────────
function parseTidFraMelding(melding) {
  const lower = melding.toLowerCase();
  const halvMatch = lower.match(/halv\s+(\w+)/);
  if (halvMatch) {
    const tallord = { en:1,ett:1,to:2,tre:3,fire:4,fem:5,seks:6,sju:7,atte:8,"åtte":8,ni:9,ti:10,elleve:11,tolv:12 };
    const t = tallord[halvMatch[1]];
    if (t) {
      const ettermiddag = (t - 1) + 12;
      const timer = (ettermiddag >= 6 && ettermiddag <= 22) ? ettermiddag : (t - 1);
      return { timer, min: 30 };
    }
  }
  const m = lower.match(/(?:kl\.?\s*)(\d{1,2})(?:[:. ](\d{2}))?|\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const timer = parseInt(m[1] ?? m[3]);
  const min   = parseInt(m[2] ?? m[4] ?? "0");
  if (isNaN(timer) || timer < 6 || timer > 22) return null;
  return { timer, min };
}

function parseDagFraMelding(melding) {
  const lower = melding.toLowerCase();
  if (/\bi dag\b|\bidag\b/.test(lower)) return new Date();
  if (/\bi morgen\b|\bimorgen\b/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() + 1); return d;
  }
  const nesteUke = /neste uke|neste uken/.test(lower);
  const dagMap = { mandag:1, tirsdag:2, onsdag:3, torsdag:4, fredag:5, lordag:6, "lørdag":6, sondag:0, "søndag":0 };
  for (const [navn, nr] of Object.entries(dagMap)) {
    if (lower.includes(navn)) {
      const na = new Date();
      let diff = nr - na.getDay();
      if (diff <= 0 || nesteUke) diff += 7;
      const dato = new Date(na);
      dato.setDate(na.getDate() + diff);
      return dato;
    }
  }
  return null;
}

async function hentLedigeTider(config, onsketDag = null, onsketTid = null) {
  const apiKey  = config.calApiKey;
  const eventId = config.calEventId;
  if (!apiKey || !eventId) {
    console.error(`[CAL] ${config.slug}: mangler calApiKey/calEventId`);
    return null;
  }
  try {
    const now   = new Date(Date.now() + 5 * 60 * 1000);
    const slutt = new Date(now);
    slutt.setDate(slutt.getDate() + 14);

    // Cal.com v2 /slots: bruk start/end og cal-api-version 2024-09-04
    const params = new URLSearchParams({
      eventTypeId: String(eventId),
      start:       now.toISOString(),
      end:         slutt.toISOString(),
      timeZone:    "Europe/Oslo"
    });

    const calCtrl = new AbortController();
    const calTimeout = setTimeout(() => calCtrl.abort(), 8000);
    const res = await fetch(`${CAL_BASE}/slots?${params}`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "cal-api-version": "2024-09-04" },
      signal: calCtrl.signal
    });
    clearTimeout(calTimeout);

    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      console.error(`[CAL] ${config.slug}: ugyldig JSON-svar (HTTP ${res.status})`);
      return null;
    }
    if (!res.ok || data.status !== "success") {
      console.error(`[CAL] ${config.slug} API-feil (HTTP ${res.status}):`, JSON.stringify(data).slice(0, 400));
      return null;
    }

    // Nytt format: data.data = { "2025-09-05": [ { start: "..." }, ... ] }
    // Gammelt format: data.data.slots = { "dato": [ { time: "..." } ] }
    const slotKilde = data.data?.slots || data.data || {};
    const alle = Object.entries(slotKilde).flatMap(([dag, tider]) =>
      (Array.isArray(tider) ? tider : []).map(t => ({ dag, tid: t.start || t.time }))
    ).filter(t => t.tid);
    if (alle.length === 0) return onsketDag ? [] : null;

    let utvalg;
    if (onsketDag) {
      const onsketStr = onsketDag.toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" });
      let dagFiltrert = alle.filter(t =>
        new Date(t.tid).toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" }) === onsketStr
      );
      if (onsketTid && dagFiltrert.length > 0) {
        const match = dagFiltrert.find(t => {
          const d = new Date(t.tid);
          const h = parseInt(d.toLocaleString("no-NO", { hour: "2-digit", timeZone: "Europe/Oslo" }));
          const mm = d.getMinutes();
          return h === onsketTid.timer && mm === onsketTid.min;
        });
        if (match) {
          utvalg = [match];
        } else {
          const onskMs = onsketTid.timer * 60 + onsketTid.min;
          const tilMin = tid => {
            const str = new Date(tid).toLocaleString("no-NO", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo" });
            const [h, mm] = str.split(":").map(Number);
            return h * 60 + mm;
          };
          dagFiltrert.sort((a, b) => Math.abs(tilMin(a.tid) - onskMs) - Math.abs(tilMin(b.tid) - onskMs));
          utvalg = dagFiltrert.slice(0, 3);
        }
      } else {
        utvalg = dagFiltrert.slice(0, 6);
      }
      if (utvalg.length === 0) return [];
    } else {
      const perDag = {};
      for (const t of alle) {
        const dag = new Date(t.tid).toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" });
        if (!perDag[dag]) perDag[dag] = [];
        if (perDag[dag].length < 2) perDag[dag].push(t);
        if (Object.keys(perDag).length >= 4 && perDag[dag].length >= 2) break;
      }
      utvalg = Object.values(perDag).flat();
    }

    return utvalg.map(t => ({
      visning: new Date(t.tid).toLocaleString("no-NO", {
        weekday: "long", day: "numeric", month: "long",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo"
      }),
      tid: t.tid
    }));
  } catch (err) {
    console.error(`[FEIL] hentLedigeTider (${config.slug}):`, err.message);
    return null;
  }
}

async function opprettBooking(config, { navn, epost, tid }) {
  const apiKey  = config.calApiKey;
  const eventId = config.calEventId;
  if (!apiKey || !eventId) return { ok: false, feil: "Booking er ikke konfigurert for denne salongen." };
  try {
    const bookCtrl = new AbortController();
    const bookTimeout = setTimeout(() => bookCtrl.abort(), 10000);
    const res = await fetch(`${CAL_BASE}/bookings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        eventTypeId: eventId,
        start: tid,
        attendee: { name: navn, email: epost, timeZone: "Europe/Oslo", language: "no" }
      }),
      signal: bookCtrl.signal
    });
    clearTimeout(bookTimeout);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== "success") {
      console.error(`[CAL] ${config.slug} booking feilet (HTTP ${res.status}):`, JSON.stringify(data).slice(0, 400));
      return { ok: false, feil: data.error?.message || "Kunne ikke fullføre bookingen." };
    }
    return { ok: true, booking: data.data };
  } catch (err) {
    console.error(`[FEIL] opprettBooking (${config.slug}):`, err.message);
    return { ok: false, feil: err.message };
  }
}

// ── SendGrid ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendBookingVarsel(config, { navn, melding }) {
  if (!SENDGRID_KEY) return;
  const til = config.epost || process.env.EPOST_TIL;
  if (!til) return;
  try {
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: til }] }],
        from: { email: EPOST_FRA, name: config.bedrift },
        subject: `Ny bookingforespørsel – ${config.bedrift}`,
        content: [{
          type: "text/html",
          value: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9f6f1;border-radius:12px;">
              <h2 style="color:#0d0d0d;margin-bottom:8px;">Ny bookingforespørsel</h2>
              <p style="color:#666;margin-bottom:20px;">En kunde ønsker å booke time hos ${escapeHtml(config.bedrift)}.</p>
              <div style="background:#fff;border-radius:8px;padding:16px;border:1px solid #e8e2d9;">
                <p><strong>Navn:</strong> ${escapeHtml(navn || "Ukjent")}</p>
                <p><strong>Melding:</strong> ${escapeHtml(melding)}</p>
                <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString("no-NO")}</p>
              </div>
              ${config.bookinglink ? `<a href="${escapeHtml(config.bookinglink)}" style="display:inline-block;margin-top:20px;background:#b8924a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;">Åpne booking</a>` : ""}
            </div>`
        }]
      })
    });
    console.log(`[EPOST] Bookingvarsel sendt til ${til} (${config.slug})`);
  } catch (err) {
    console.error("[FEIL] sendBookingVarsel:", err.message);
  }
}

// ── Telegram-varsel ───────────────────────────────────────────────────────────
// Sender en melding til deg umiddelbart. Krever TELEGRAM_BOT_TOKEN og
// TELEGRAM_CHAT_ID som miljøvariabler. Gjør ingenting hvis de mangler.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
async function sendTelegram(tekst) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: tekst,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error("[TELEGRAM] Feil:", err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  APP
// ════════════════════════════════════════════════════════════════════════════
const app = express();
app.set("trust proxy", 1); // Render sitter bak proxy – nødvendig for korrekt req.ip
// Global JSON-parser med liten grense, men hopp over bildeopplasting (egen 8mb-parser).
app.use((req, res, next) => {
  if (req.path === "/last-opp-bilde") return next();
  express.json({ limit: "10kb" })(req, res, next);
});

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsPublic = cors({ origin: "*" });

// ── Admin-token (konstant-tid sammenligning) ───────────────────────────────────
function sikkerLik(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function krevAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, feil: "Tjenesten er ikke konfigurert for dette." });
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!sikkerLik(token, ADMIN_TOKEN)) {
    console.warn(`[SIKKERHET] Avvist admin-kall fra ${req.ip} mot ${req.path}`);
    return res.status(401).json({ ok: false, feil: "Ikke autorisert." });
  }
  next();
}

// ── Rate limiting ───────────────────────────────────────────────────────────
const rateLimitMap = new Map();
setInterval(() => {
  const grense = Date.now() - 60_000;
  for (const [k, e] of rateLimitMap) if (e.start < grense) rateLimitMap.delete(k);
}, 5 * 60_000).unref();

function lagRateLimit(maxRequests, prefix = "") {
  return function (req, res, next) {
    const key = prefix + req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > 60_000) { entry.count = 1; entry.start = now; }
    else { entry.count++; }
    rateLimitMap.set(key, entry);
    if (entry.count > maxRequests) {
      return res.status(429).json({ ok: false, reply: "For mange foresporsler. Prov igjen om litt." });
    }
    next();
  };
}
const rateLimitChat = lagRateLimit(20, "chat:");
const rateLimitBook = lagRateLimit(5,  "book:");
const rateLimitDash = lagRateLimit(10, "dash:");
const rateLimitProv = lagRateLimit(3,  "prov:");
const rateLimitOpp  = lagRateLimit(10, "opp:");   // bildeopplasting

// ── Statiske sider (tenant-uavhengige filer) ───────────────────────────────────
// index.html får injisert riktig salong-config server-side.
app.get("/", corsPublic, krevTenant, (req, res) => {
  try {
    let html = readFileSync(path.join(__dirname, "index.html"), "utf-8");
    const offentlig = offentligConfig(req.tenant);
    const configScript = `<script>window.SALONG_CONFIG = ${JSON.stringify(offentlig)};</script>`;
    html = html.replace("</head>", configScript + "\n</head>");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(500).send("Feil ved lasting av nettside: " + err.message);
  }
});
app.get("/chat",      corsPublic, (_req, res) => res.sendFile(path.join(__dirname, "chat.html")));
app.get("/kom-igang", corsPublic, (_req, res) => res.sendFile(path.join(__dirname, "onboarding.html")));
app.get("/dashboard", corsPublic, (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/widget.js", corsPublic, (_req, res) => res.sendFile(path.join(__dirname, "widget.js")));

app.get("/health", corsPublic, async (req, res) => {
  const slug = utledSlug(req);
  const config = await hentTenant(slug);
  res.json({ status: "ok", slug, bedrift: config?.bedrift || null });
});

// Bare de feltene nettsiden/widget trenger – ingen API-nøkler ut.
function offentligConfig(c) {
  return {
    slug: c.slug, bedrift: c.bedrift, beskrivelse: c.beskrivelse,
    velkomst: c.velkomst, adresse: c.adresse, telefon: c.telefon, epost: c.epost,
    bookinglink: c.bookinglink, tjenester: c.tjenester, priser: c.priser,
    apningstider: c.apningstider, farge: c.farge, bakgrunn: c.bakgrunn,
    sekundarfarge: c.sekundarfarge,
    usp: c.usp, produkter: c.produkter, erfaringAar: c.erfaringAar,
    ansatte: c.ansatte, kunder: c.kunder, bildeHero: c.bildeHero, bildeOm: c.bildeOm
  };
}

app.get("/api/config", corsPublic, krevTenant, (req, res) => {
  res.json(offentligConfig(req.tenant));
});

// ── /chat ─────────────────────────────────────────────────────────────────────
app.post("/chat", corsPublic, rateLimitChat, krevTenant, async (req, res) => {
  const config = req.tenant;
  const { message, name, history = [] } = req.body;

  if (!message || typeof message !== "string")
    return res.status(400).json({ reply: "Melding mangler eller er ugyldig." });
  if (message.trim().length > 500)
    return res.status(400).json({ reply: "Meldingen er for lang (maks 500 tegn)." });
  if (!OPENAI_API_KEY)
    return res.status(500).json({ reply: "Konfigurasjonsfeil pa server." });

  const safeName = name && typeof name === "string" ? name.slice(0, 50) : null;
  const systemPrompt = byggSystemPrompt(config);
  const systemContent = safeName ? `${systemPrompt}\n\nKundens navn: ${safeName}` : systemPrompt;

  const allowedRoles = new Set(["user", "assistant"]);
  const safeHistory = Array.isArray(history)
    ? history.filter(m => allowedRoles.has(m?.role) && typeof m?.content === "string")
             .slice(-14)
             .map(m => ({ role: m.role, content: m.content.slice(0, 800) }))
    : [];

  const messages = [
    { role: "system", content: systemContent },
    ...safeHistory,
    { role: "user", content: message.trim() }
  ];

  try {
    const aiCtrl = new AbortController();
    const aiTimeout = setTimeout(() => aiCtrl.abort(), 12000);
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 400, temperature: 0.6 }),
      signal: aiCtrl.signal
    });
    clearTimeout(aiTimeout);

    if (!openaiRes.ok) {
      console.error("[FEIL] OpenAI:", openaiRes.status);
      return res.status(502).json({ reply: "Kunne ikke na AI-tjenesten. Prov igjen." });
    }

    let rawReply;
    try {
      const data = await openaiRes.json();
      rawReply = data.choices?.[0]?.message?.content?.trim() ?? "Beklager, noe gikk galt.";
    } catch {
      return res.status(502).json({ reply: "Fikk ugyldig svar fra AI. Prøv igjen." });
    }

    const hasBookTag = rawReply.includes("[BOOK]");
    const reply = rawReply.replace(/\[BOOK\]/g, "").trim();

    // Navnedeteksjon: krev eksplisitt introduksjon eller for-/etternavn (2 ord)
    let detektertNavn = null;
    if (!safeName) {
      const raw = message.trim();
      const lower = raw.toLowerCase();
      const stoppord = new Set([
        "er","har","kan","vil","hva","når","hvor","how","what","when",
        "ok","ja","nei","hei","hallo","heisann","takk","super","greit","bra","flott",
        "yes","no","sure","great","klipp","farge","time","booking","booke","bestille",
        "mandag","tirsdag","onsdag","torsdag","fredag","lørdag","søndag","lordag","sondag",
        "herreklipp","dameklipp","barneklipp","behandling","gavekort","pris","priser",
        "i","dag","morgen","kveld","drop-in","dropin"
      ]);
      const introMatch = lower.match(/(?:jeg heter|navnet mitt er|jeg er|mitt navn er|heter)\s+([a-zæøåA-ZÆØÅ][a-zæøåA-ZÆØÅ\- ]{1,38})/);
      if (introMatch) {
        const kandidat = introMatch[1].trim().split(/\s+/).slice(0, 3);
        if (!kandidat.some(w => stoppord.has(w.toLowerCase())))
          detektertNavn = kandidat.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      }
      if (!detektertNavn && !raw.includes("?") && !raw.includes("!")) {
        const ord = raw.split(/\s+/);
        const bareBokstav = ord.every(w => /^[a-zæøåA-ZÆØÅ\-]+$/.test(w));
        if (ord.length === 2 && bareBokstav && !ord.some(w => stoppord.has(w.toLowerCase())))
          detektertNavn = ord.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      }
    }

    let ledigeTider = null;
    if (hasBookTag) {
      const onsketDag = parseDagFraMelding(message);
      const onsketTid = parseTidFraMelding(message);
      ledigeTider = await hentLedigeTider(config, onsketDag, onsketTid);
    }

    const bookingUrl = hasBookTag && ledigeTider === null ? (config.bookinglink || null) : null;

    loggSamtale({
      slug: config.slug, bedrift: config.bedrift,
      navn: safeName, melding: message, svar: reply, bookingVist: !!bookingUrl
    }).catch(() => {});
    if (bookingUrl) sendBookingVarsel(config, { navn: safeName, melding: message }).catch(() => {});

    return res.json({ reply, bookingUrl, ledigeTider, detektertNavn });
  } catch (err) {
    console.error("[FEIL] /chat:", err.message);
    return res.status(500).json({ reply: "Serverfeil. Prov igjen senere." });
  }
});

// ── /book ─────────────────────────────────────────────────────────────────────
app.post("/book", corsPublic, rateLimitBook, krevTenant, async (req, res) => {
  const config = req.tenant;
  const { navn, epost, tid } = req.body;

  if (!navn || !epost || !tid)
    return res.status(400).json({ ok: false, feil: "Navn, e-post og tidspunkt er påkrevd." });
  if (typeof navn !== "string" || typeof epost !== "string" || typeof tid !== "string")
    return res.status(400).json({ ok: false, feil: "Ugyldig datatype i forespørsel." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost))
    return res.status(400).json({ ok: false, feil: "Ugyldig e-postadresse." });
  const tidDato = new Date(tid);
  if (isNaN(tidDato.getTime()) || tidDato < new Date(Date.now() - 30_000))
    return res.status(400).json({ ok: false, feil: "Ugyldig eller passert tidspunkt." });

  let resultat;
  try {
    resultat = await opprettBooking(config, { navn: navn.slice(0, 100), epost: epost.slice(0, 200), tid });
  } catch (err) {
    console.error("[BOOK] Uventet feil:", err.message);
    return res.status(500).json({ ok: false, feil: "Serverfeil ved booking. Prøv igjen." });
  }
  if (!resultat.ok) return res.status(502).json({ ok: false, feil: resultat.feil });

  sendBookingVarsel(config, { navn, melding: `Ny booking: ${tid}` }).catch(() => {});
  sendTelegram(
    `📅 <b>Ny booking hos ${escapeHtml(config.bedrift)}</b>\n\n` +
    `Navn: ${escapeHtml(navn)}\n` +
    `Tid: ${escapeHtml(new Date(tid).toLocaleString("no-NO", { timeZone: "Europe/Oslo" }))}`
  ).catch(() => {});
  const bookingUid = resultat.booking?.uid || resultat.booking?.id || null;
  return res.json({ ok: true, bookingUid });
});

// ── Cal.com event-lookup (brukt av onboarding) ─────────────────────────────────
app.get("/cal-lookup", corsPublic, async (req, res) => {
  const { username, slug, apiKey, eventId } = req.query;
  // Onboarding kan sende egne nøkler; ellers fall tilbake til server-default
  const key = apiKey || process.env.CAL_API_KEY;
  const id  = eventId || process.env.CAL_EVENT_TYPE_ID;
  if (!key || !id) return res.json({ ok: false, feil: "Mangler Cal.com-konfigurasjon." });
  try {
    const now = new Date(Date.now() + 5 * 60 * 1000);
    const slutt = new Date(now); slutt.setDate(slutt.getDate() + 7);
    const params = new URLSearchParams({
      eventTypeId: String(id), start: now.toISOString(),
      end: slutt.toISOString(), timeZone: "Europe/Oslo"
    });
    const r = await fetch(`${CAL_BASE}/slots?${params}`, {
      headers: { "Authorization": `Bearer ${key}`, "cal-api-version": "2024-09-04" }
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.status === "success")
      return res.json({ ok: true, id: String(id), navn: decodeURIComponent(slug || "").replace(/-/g, " "), varighet: 30 });
    return res.json({ ok: false, feil: "Kunne ikke verifisere Cal.com event type. Sjekk URL-en." });
  } catch (err) {
    return res.json({ ok: false, feil: "Serverfeil: " + err.message });
  }
});

// ── Dashboard-data (auth via salong-nøkkel) ─────────────────────────────────────
app.post("/dashboard-data", corsPublic, rateLimitDash, async (req, res) => {
  const { nokkel, epost } = req.body;
  if (!nokkel && !epost) return res.status(400).json({ error: "Nokkel eller e-post mangler." });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: "Database ikke konfigurert." });
  try {
    // Finn salongen enten via nøkkel eller via e-post (config->>epost)
    let filter;
    if (nokkel) {
      filter = `nokkel=eq.${encodeURIComponent(nokkel)}`;
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) return res.status(400).json({ error: "Ugyldig e-post." });
      filter = `config->>epost=eq.${encodeURIComponent(epost)}`;
    }
    const kundeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/salonger?${filter}&select=slug,bedrift`,
      { headers: supaHeaders() }
    );
    const kunder = await kundeRes.json();
    if (!Array.isArray(kunder) || !kunder.length) return res.status(401).json({ error: "Fant ingen salong." });

    const kunde = kunder[0];
    const samtaleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/samtaler?slug=eq.${encodeURIComponent(kunde.slug)}&order=opprettet.desc&select=*`,
      { headers: supaHeaders() }
    );
    const samtaler = await samtaleRes.json();
    return res.json({ bedrift: kunde.bedrift, slug: kunde.slug, samtaler: Array.isArray(samtaler) ? samtaler : [] });
  } catch (err) {
    console.error("[FEIL] dashboard-data:", err.message);
    return res.status(500).json({ error: "Serverfeil. Prøv igjen." });
  }
});

// ── Slett samtale (kun egen salongs samtaler) ───────────────────────────────────
app.delete("/slett-samtale", corsPublic, rateLimitDash, async (req, res) => {
  const { id, nokkel, epost } = req.body;
  if (!id || (!nokkel && !epost)) return res.status(400).json({ error: "Mangler id og nokkel/epost." });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: "Database ikke konfigurert." });
  const idStr = String(id);
  const gyldigId = /^[0-9]+$/.test(idStr) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idStr);
  if (!gyldigId) return res.status(400).json({ error: "Ugyldig id." });
  try {
    let filter;
    if (nokkel) {
      filter = `nokkel=eq.${encodeURIComponent(nokkel)}`;
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) return res.status(400).json({ error: "Ugyldig e-post." });
      filter = `config->>epost=eq.${encodeURIComponent(epost)}`;
    }
    const kundeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/salonger?${filter}&select=slug`,
      { headers: supaHeaders() }
    );
    const kunder = await kundeRes.json();
    if (!Array.isArray(kunder) || !kunder.length) return res.status(401).json({ error: "Fant ingen salong." });

    const slug = kunder[0].slug;
    const slettRes = await fetch(
      `${SUPABASE_URL}/rest/v1/samtaler?id=eq.${encodeURIComponent(idStr)}&slug=eq.${encodeURIComponent(slug)}`,
      { method: "DELETE", headers: supaHeaders({ "Prefer": "return=representation" }) }
    );
    const slettet = await slettRes.json().catch(() => []);
    if (!Array.isArray(slettet) || slettet.length === 0)
      return res.status(404).json({ error: "Fant ingen samtale å slette." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[FEIL] slett-samtale:", err.message);
    return res.status(500).json({ error: "Serverfeil. Prøv igjen." });
  }
});

// ── /last-opp-bilde – tar imot et bilde (base64), laster opp til Supabase Storage ─
//   Går gjennom serveren (service_role) så bucketen ikke er åpen for skriving fra
//   nettleseren. Validerer filtype og størrelse. Returnerer offentlig URL.
const opplastParser = express.json({ limit: "8mb" });
app.post("/last-opp-bilde", corsPublic, rateLimitOpp, opplastParser, async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(503).json({ ok: false, feil: "Lagring ikke konfigurert." });

  const { fil, filtype } = req.body || {};
  if (!fil || typeof fil !== "string")
    return res.status(400).json({ ok: false, feil: "Mangler bildedata." });

  // Tillatte bildetyper
  const tillatt = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  if (!tillatt[filtype])
    return res.status(400).json({ ok: false, feil: "Kun JPG, PNG, WEBP eller GIF er tillatt." });

  // Strip evt. data-URL-prefiks og dekod base64
  const reinBase64 = fil.replace(/^data:[^;]+;base64,/, "");
  let bytes;
  try {
    bytes = Buffer.from(reinBase64, "base64");
  } catch {
    return res.status(400).json({ ok: false, feil: "Ugyldig bildedata." });
  }
  // Maks 5 MB
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024)
    return res.status(400).json({ ok: false, feil: "Bildet må være mellom 0 og 5 MB." });

  // Tilfeldig filnavn
  const tilfeldig = [...crypto.getRandomValues(new Uint8Array(12))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const filnavn = `${Date.now()}-${tilfeldig}.${tillatt[filtype]}`;

  try {
    const r = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BILDE_BUCKET}/${filnavn}`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": filtype,
          "x-upsert": "true"
        },
        body: bytes
      }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("[OPPLAST] Supabase Storage-feil:", r.status, txt);
      return res.status(502).json({ ok: false, feil: "Kunne ikke laste opp bildet." });
    }
    const offentligUrl = `${SUPABASE_URL}/storage/v1/object/public/${BILDE_BUCKET}/${filnavn}`;
    return res.json({ ok: true, url: offentligUrl });
  } catch (err) {
    console.error("[OPPLAST] Feil:", err.message);
    return res.status(500).json({ ok: false, feil: "Serverfeil ved opplasting." });
  }
});

// ── /onboarding-soknad – offentlig: sender salong-config til eier for godkjenning ─
//   Onboarding-siden er offentlig, så den oppretter IKKE en salong direkte.
//   Den sender konfigurasjonen til eieren, som aktiverer via admin-verktøyet.
app.post("/onboarding-soknad", corsPublic, rateLimitProv, async (req, res) => {
  const { konfig } = req.body;
  if (!konfig?.bedrift || !konfig?.epost)
    return res.status(400).json({ ok: false, feil: "Mangler salongnavn eller e-post." });
  if (typeof konfig.bedrift !== "string" || konfig.bedrift.length > 120)
    return res.status(400).json({ ok: false, feil: "Ugyldig salongnavn." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(konfig.epost))
    return res.status(400).json({ ok: false, feil: "Ugyldig e-postadresse." });

  const eierEpost = process.env.ONBOARDING_EPOST || EPOST_FRA;
  if (SENDGRID_KEY) {
    try {
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: eierEpost }] }],
          from: { email: EPOST_FRA, name: "AI-Salong onboarding" },
          subject: `Ny salong-søknad: ${konfig.bedrift}`,
          content: [{
            type: "text/html",
            value: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
              <h2>Ny salong vil registrere seg</h2>
              <p><strong>${escapeHtml(konfig.bedrift)}</strong> (${escapeHtml(konfig.epost)})</p>
              <p>Foreslått slug: <code>${escapeHtml(normaliserSlug(konfig.slug || konfig.bedrift))}</code></p>
              <p>Aktiver med admin-verktøyet. Full config:</p>
              <pre style="background:#f5f0e8;padding:16px;border-radius:8px;overflow:auto;font-size:12px;">${escapeHtml(JSON.stringify(konfig, null, 2))}</pre>
            </div>`
          }]
        })
      });
    } catch (err) {
      console.error("[ONBOARDING] E-post feil:", err.message);
    }
  }
  // Telegram-varsel (umiddelbart, hvis konfigurert)
  sendTelegram(
    `🆕 <b>Ny salong-søknad</b>\n\n` +
    `<b>${escapeHtml(konfig.bedrift)}</b>\n` +
    `${escapeHtml(konfig.epost)}\n` +
    `Slug: <code>${escapeHtml(normaliserSlug(konfig.slug || konfig.bedrift))}</code>\n\n` +
    `Detaljene ligger i e-posten din.`
  ).catch(() => {});

  console.log(`[ONBOARDING] Søknad mottatt: ${konfig.bedrift} (${konfig.epost})`);
  return res.json({ ok: true });
});

// ── /provision – oppretter/oppdaterer en salong i databasen (admin-token) ───────
//   I multi-tenant-modellen lager dette IKKE en ny server – bare en databaserad.
//   Ny salong er live umiddelbart på  https://<host>/?salong=<slug>  (eller subdomene).
app.post("/provision", corsPublic, rateLimitProv, krevAdminToken, async (req, res) => {
  const { konfig } = req.body;
  if (!konfig?.bedrift || !konfig?.epost)
    return res.status(400).json({ ok: false, feil: "Mangler salongnavn eller e-post." });
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(503).json({ ok: false, feil: "Database ikke konfigurert." });

  const slug = normaliserSlug(konfig.slug || konfig.bedrift);
  if (!slug) return res.status(400).json({ ok: false, feil: "Kunne ikke lage gyldig slug fra salongnavn." });

  // Generer en tilfeldig dashboard-nøkkel (lang, ikke gjettbar)
  const nokkel = "sk_" + [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

  const config = {
    bedrift: konfig.bedrift, bransje: konfig.bransje || "frisørsalong",
    tone: konfig.tone || "vennlig og profesjonell", sprakOgLand: "norsk",
    velkomst: konfig.velkomst || "", adresse: konfig.adresse || "",
    telefon: konfig.telefon || "", epost: konfig.epost || "",
    bookinglink: konfig.bookinglink || "", tjenester: konfig.tjenester || [],
    priser: konfig.priser || [], apningstider: konfig.apningstider || {},
    farge: konfig.farge || "#b8924a", bakgrunn: konfig.bakgrunn || "#f5f0e8",
    sekundarfarge: konfig.sekundarfarge || "#8a6a2a",
    beskrivelse: konfig.beskrivelse || "", usp: konfig.usp || [],
    produkter: konfig.produkter || "", erfaringAar: konfig.erfaringAar || "",
    ansatte: konfig.ansatte || "", kunder: konfig.kunder || "",
    bildeHero: konfig.bildeHero || "", bildeOm: konfig.bildeOm || "",
    ekstraInfo: konfig.ekstraInfo || "",
    faq: konfig.faq || {
      drop_in: "Vi tar imot drop-in hvis det er ledig kapasitet, men vi anbefaler å booke time.",
      avbestilling: "Avbestilling må skje senest 24 timer før timen.",
      betaling: "Vi tar imot kort og Vipps.",
      allergitest: "Vi anbefaler allergitest 48 timer før farging.",
      garanti: "Er du ikke fornøyd? Kom tilbake innen 7 dager, så fikser vi det gratis."
    }
  };

  const rad = {
    slug, bedrift: konfig.bedrift, nokkel, aktiv: true,
    cal_event_id: Number(konfig.calEventId || process.env.CAL_EVENT_TYPE_ID || 0),
    cal_api_key: konfig.calApiKey || process.env.CAL_API_KEY || "",
    config
  };

  try {
    // Upsert på slug (oppdater hvis finnes, ellers opprett)
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/salonger?on_conflict=slug`,
      {
        method: "POST",
        headers: supaHeaders({ "Prefer": "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify(rad)
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error("[PROVISION] Supabase-feil:", JSON.stringify(data));
      return res.status(502).json({ ok: false, feil: "Kunne ikke lagre salong: " + (data.message || "ukjent") });
    }

    tomTenantCache(slug);

    const host = req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = BASE_DOMAIN
      ? `${proto}://${slug}.${BASE_DOMAIN}`
      : `${proto}://${host}/?salong=${slug}`;

    // Velkomstepost (asynkront)
    if (SENDGRID_KEY) {
      fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: konfig.epost }] }],
          from: { email: EPOST_FRA, name: "AI-Salong" },
          subject: `🎉 ${konfig.bedrift} er klar`,
          content: [{
            type: "text/html",
            value: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f5f0e8;border-radius:12px;">
                <h1 style="font-size:26px;margin-bottom:8px;">Velkommen, ${escapeHtml(konfig.bedrift)}! 🎉</h1>
                <p style="color:#666;margin-bottom:24px;">Din AI-assistent, nettside og dashboard er klare.</p>
                <div style="background:#fff;border-radius:8px;padding:20px;">
                  <p><strong>🌐 Nettside:</strong> <a href="${baseUrl}">${baseUrl}</a></p>
                  <p><strong>📊 Dashboard-nøkkel:</strong> <code>${nokkel}</code></p>
                </div>
              </div>`
          }]
        })
      }).catch(err => console.error("[PROVISION] E-post feil:", err.message));
    }

    console.log(`[PROVISION] Salong lagret: ${konfig.bedrift} (${slug})`);
    return res.json({ ok: true, slug, url: baseUrl, nokkel });
  } catch (err) {
    console.error("[PROVISION] Feil:", err.message);
    return res.status(500).json({ ok: false, feil: err.message });
  }
});

// ── Admin: list alle salonger ───────────────────────────────────────────────────
app.get("/admin/salonger", corsPublic, krevAdminToken, async (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ ok: false });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/salonger?select=slug,bedrift,epost:config->>epost,aktiv,opprettet&order=opprettet.desc`,
      { headers: supaHeaders() }
    );
    const data = await r.json();
    return res.json({ ok: true, salonger: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, feil: err.message });
  }
});

// 404
app.use((_req, res) => res.status(404).json({ error: "Endepunkt ikke funnet." }));

app.listen(PORT, () => {
  console.log(`[SERVER] Multi-tenant AI-salong kjorer pa port ${PORT}`);
  console.log(`[SERVER] Default-slug: ${DEFAULT_SLUG}${BASE_DOMAIN ? ` | Basisdomene: ${BASE_DOMAIN}` : ""}`);
});
