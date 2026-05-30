import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Les konfigurasjon ─────────────────────────────────────────────────────────

let CONFIG;
try {
  CONFIG = JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf-8"));
} catch (err) {
  console.error("[FEIL] Kunne ikke lese config.json:", err.message);
  process.exit(1); // Avslutt tydelig med feilkode
}

// ── Supabase ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function loggSamtale({ navn, melding, svar, bookingVist }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/samtaler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        bedrift: CONFIG.bedrift,
        navn: navn || "Ukjent",
        melding,
        svar,
        booking_vist: bookingVist
      })
    });
  } catch (err) {
    console.error("[FEIL] Kunne ikke lagre samtale til Supabase:", err.message);
  }
}

function byggSystemPrompt(config) {
  const priser      = config.priser?.join("\n  - ") || "Kontakt salongen for priser";
  const tjenester   = config.tjenester?.join(", ") || "";
  const apningstider = Object.entries(config.apningstider || {})
    .map(([dag, tid]) => `  ${dag}: ${tid}`)
    .join("\n");
  const faqLinjer = Object.entries(config.faq || {})
    .map(([nokkel, svar]) => `  - ${svar}`)
    .join("\n");

  return `Du er en ${config.tone || "vennlig og profesjonell"} kundeserviceassistent for ${config.bedrift}, en ${config.bransje}.

Retningslinjer:
- Svar alltid pa ${config.sprakOgLand || "norsk"}, kort og konkret (maks 3 setninger).
- Var varm og imotekommende - bruk kundens navn hvis du kjenner det.
- Hvis sporsmalet ikke er relevant for ${config.bransje}, avvis hoflig og hold deg til temaet.
- Svar alltid fra informasjonen nedenfor. Hvis du ikke vet svaret, be kunden ringe eller sende e-post.
- Hvis du ikke kjenner kundens navn og samtalen er i gang (ikke første melding), kan du spørre høflig og naturlig om navnet EN gang. Eksempel: "Forresten, hva heter du?" eller "Hyggelig! Hva er navnet ditt?". Gjør det kun hvis det føles naturlig, ikke som et skjema.
- Når kunden oppgir navnet sitt, bruk det i svaret og husk det resten av samtalen.
- Du KAN vise ledige tider - disse hentes automatisk fra kalenderen og vises under svaret ditt.
- Du KAN IKKE bekrefte, reservere eller booke tider direkte - kunden klikker pa en ledig tid.

REGLER FOR [BOOK]-TAG:
- Avslutt med [BOOK] pa en HELT EGEN LINJE kun nar kunden eksplisitt vil bestille, se ledige tider, eller spor om booking.
- Eksempler der du SKAL bruke [BOOK]:
  * "kan jeg bestille time?" → "Selvfolgelig! La meg sjekke ledige tider.\n[BOOK]"
  * "er det noen ledige tider?" → "Jeg sjekker for deg!\n[BOOK]"
  * "vil booke pa fredag" → "Jeg sjekker fredag for deg!\n[BOOK]"
  * "kan jeg endre til torsdag 12?" → "Jeg sjekker om torsdag 12:00 er ledig!\n[BOOK]"
- Eksempler der du IKKE skal bruke [BOOK]:
  * "er dere apne pa lordag?" → svar med apningstider, ingen [BOOK]
  * "er det ledig?" KUN hvis du nettopp viste tider i samme samtale → si "Klikk pa en av tidene over for a booke!"
  * "hva koster en klipp?" → svar med pris, ingen [BOOK]
  * "takk" / "ok" / "greit" → vanlig svar, ingen [BOOK]
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

const SYSTEM_PROMPT = byggSystemPrompt(CONFIG);

// ── Calendly ──────────────────────────────────────────────────────────────────

const CAL_API_KEY       = process.env.CAL_API_KEY;
const CAL_EVENT_TYPE_ID = Number(process.env.CAL_EVENT_TYPE_ID) || 0;
const CAL_BASE          = "https://api.cal.eu/v2";

// Advar ved oppstart hvis Cal.com-konfig mangler
if (!CAL_API_KEY)        console.warn("[ADVARSEL] CAL_API_KEY er ikke satt – booking vil ikke fungere");
if (!CAL_EVENT_TYPE_ID)  console.warn("[ADVARSEL] CAL_EVENT_TYPE_ID er ikke satt – booking vil ikke fungere");

// Parser klokkeslett fra melding – krever "kl", ":" eller "."-format for å unngå falske treff
// Støtter: "kl 14", "kl. 14:30", "14:00", "14.00", "halv 3" (=14:30), "kvart over 2" (=14:15)
function parseTidFraMelding(melding) {
  const lower = melding.toLowerCase();

  // Halv X → X*100 - 30 min (halv 3 = 14:30 i norsk kontekst, dvs. halv tre = 14:30)
  const halvMatch = lower.match(/halv\s+(\w+)/);
  if (halvMatch) {
    const tallord = { en:1,ett:1,to:2,tre:3,fire:4,fem:5,seks:6,sju:7,atte:8,åtte:8,ni:9,ti:10,elleve:11,tolv:12 };
    const t = tallord[halvMatch[1]];
    if (t) {
      // Prøv ettermiddag først (mer sannsynlig for frisørsalong): halv tre = 14:30
      const ettermiddag = (t - 1) + 12;
      const timer = (ettermiddag >= 6 && ettermiddag <= 22) ? ettermiddag : (t - 1);
      return { timer, min: 30 };
    }
  }

  // Krev "kl", ":", eller "." mellom timer og minutt
  const m = lower.match(/(?:kl\.?\s*)(\d{1,2})(?:[:. ](\d{2}))?|\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const timer = parseInt(m[1] ?? m[3]);
  const min   = parseInt(m[2] ?? m[4] ?? "0");
  if (isNaN(timer) || timer < 6 || timer > 22) return null;
  return { timer, min };
}

// Parser hvilken dag brukeren spør om
function parseDagFraMelding(melding) {
  const lower = melding.toLowerCase();
  if (/\bi dag\b|\bidag\b/.test(lower)) return new Date();
  if (/\bi morgen\b|\bimorgen\b/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() + 1); return d;
  }
  // "neste uke" → hopp 7 dager frem
  const nesteUke = /neste uke|neste uken/.test(lower);
  const dagMap = { mandag:1, tirsdag:2, onsdag:3, torsdag:4, fredag:5, lordag:6, "l\u00f8rdag":6, sondag:0, "s\u00f8ndag":0 };
  for (const [navn, nr] of Object.entries(dagMap)) {
    if (lower.includes(navn)) {
      const na = new Date();
      let diff = nr - na.getDay();
      // Hvis dagen allerede er passert denne uken, eller "neste uke" er nevnt → neste forekomst
      if (diff <= 0 || nesteUke) diff += 7;
      const dato = new Date(na);
      dato.setDate(na.getDate() + diff);
      return dato;
    }
  }
  return null;
}

async function hentLedigeTider(onsketDag = null, onsketTid = null) {
  if (!CAL_API_KEY || !CAL_EVENT_TYPE_ID) {
    console.error("[CAL] Mangler CAL_API_KEY eller CAL_EVENT_TYPE_ID");
    return null;
  }
  try {
    const now   = new Date(Date.now() + 5 * 60 * 1000);
    const slutt = new Date(now);
    slutt.setDate(slutt.getDate() + 14); // 14 dager for å finne nok tider

    const params = new URLSearchParams({
      eventTypeId: String(CAL_EVENT_TYPE_ID),
      startTime:   now.toISOString(),
      endTime:     slutt.toISOString(),
      timeZone:    "Europe/Oslo"
    });

    const url = `${CAL_BASE}/slots/available?${params}`;
    console.log("[CAL] Henter slots:", url);

    const calCtrl = new AbortController();
    const calTimeout = setTimeout(() => calCtrl.abort(), 8000); // 8 sek
    const res  = await fetch(url, {
      headers: {
        "Authorization":    `Bearer ${CAL_API_KEY}`,
        "cal-api-version":  "2024-08-13"
      },
      signal: calCtrl.signal
    });
    clearTimeout(calTimeout);

    const raw  = await res.text();
    const data = JSON.parse(raw);

    if (data.status !== "success") {
      console.error("[CAL] API feil:", JSON.stringify(data));
      return null;
    }

    // Flatt ut slots-objektet { "2024-08-26": [{time:...}, ...], ... }
    const slots = data.data?.slots || {};
    const alle  = Object.entries(slots).flatMap(([dag, tider]) =>
      tider.map(t => ({ dag, tid: t.time }))
    );

    if (alle.length === 0) {
      console.warn("[CAL] 0 ledige tider totalt");
      // Returner [] (ingen tider) ikke null (feil) – Cal.com svarte OK men ingen tider
      return onsketDag ? [] : null;
    }

    let utvalg;

    if (onsketDag) {
      const onsketStr = onsketDag.toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" });
      let dagFiltrert = alle.filter(t =>
        new Date(t.tid).toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" }) === onsketStr
      );

      // Hvis spesifikt klokkeslett er ønsket, finn nærmeste ledige tid
      if (onsketTid && dagFiltrert.length > 0) {
        const match = dagFiltrert.find(t => {
          const d = new Date(t.tid);
          const h = parseInt(d.toLocaleString("no-NO", { hour: "numeric", timeZone: "Europe/Oslo" }));
          const m = d.getMinutes();
          return h === onsketTid.timer && m === onsketTid.min;
        });
        if (match) {
          utvalg = [match];
          console.log(`[CAL] Eksakt tid funnet: ${match.tid}`);
        } else {
          // Finn nærmeste tilgjengelige tider rundt ønsket tidspunkt
          // Bruk Oslo-tid (ikke UTC) for korrekt sammenligning
          const onskMs = onsketTid.timer * 60 + onsketTid.min;
          const tilMin = tid => {
            const str = new Date(tid).toLocaleString("no-NO", {
              hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo"
            });
            const [h, m] = str.split(":").map(Number);
            return h * 60 + m;
          };
          dagFiltrert.sort((a, b) =>
            Math.abs(tilMin(a.tid) - onskMs) - Math.abs(tilMin(b.tid) - onskMs)
          );
          utvalg = dagFiltrert.slice(0, 3);
          console.log(`[CAL] Ønsket tid ikke ledig, viser nærmeste: ${utvalg.length} tider`);
        }
      } else {
        utvalg = dagFiltrert.slice(0, 6);
      }

      console.log(`[CAL] Filtrert til ${onsketStr}: ${utvalg.length} tider`);
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
      console.log(`[CAL] Viser ${utvalg.length} tider fordelt pa ${Object.keys(perDag).length} dager`);
    }

    return utvalg.map(t => ({
      visning: new Date(t.tid).toLocaleString("no-NO", {
        weekday: "long", day: "numeric", month: "long",
        hour: "2-digit", minute: "2-digit",
        timeZone: "Europe/Oslo"
      }),
      tid: t.tid
    }));

  } catch (err) {
    console.error("[FEIL] Cal.com hentLedigeTider:", err.message);
    return null;
  }
}

async function opprettBooking({ navn, epost, tid }) {
  try {
    const bookCtrl    = new AbortController();
    const bookTimeout = setTimeout(() => bookCtrl.abort(), 10000); // 10 sek
    const res = await fetch(`${CAL_BASE}/bookings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CAL_API_KEY}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        eventTypeId: CAL_EVENT_TYPE_ID,
        start: tid,
        attendee: {
          name: navn,
          email: epost,
          timeZone: "Europe/Oslo",
          language: "no"
        }
      }),
      signal: bookCtrl.signal
    });
    clearTimeout(bookTimeout);
    const data = await res.json();
    if (data.status !== "success") {
      console.error("[CAL] Booking feilet:", JSON.stringify(data));
      return { ok: false, feil: data.error?.message || "Ukjent feil" };
    }
    console.log(`[CAL] Booking opprettet: ${navn} (${epost}) – ${tid}`);
    return { ok: true, booking: data.data };
  } catch (err) {
    console.error("[FEIL] Cal.com opprettBooking:", err.message);
    return { ok: false, feil: err.message };
  }
}

// ── SendGrid e-post ───────────────────────────────────────────────────────────

const SENDGRID_KEY = process.env.SENDGRID_KEY;
const EPOST_FRA    = "mathias.s.vinnes@gmail.com";
const EPOST_TIL    = "asiakimchi25@gmail.com";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendBookingVarsel({ navn, melding }) {
  if (!SENDGRID_KEY) return;
  try {
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: EPOST_TIL }] }],
        from: { email: EPOST_FRA, name: CONFIG.bedrift },
        subject: `Ny bookingforespørsel – ${CONFIG.bedrift}`,
        content: [{
          type: "text/html",
          value: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9f6f1;border-radius:12px;">
              <h2 style="color:#0d0d0d;margin-bottom:8px;">Ny bookingforespørsel</h2>
              <p style="color:#666;margin-bottom:20px;">En kunde ønsker å booke time hos ${CONFIG.bedrift}.</p>
              <div style="background:#fff;border-radius:8px;padding:16px;border:1px solid #e8e2d9;">
                <p><strong>Navn:</strong> ${escapeHtml(navn || "Ukjent")}</p>
                <p><strong>Melding:</strong> ${escapeHtml(melding)}</p>
                <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString("no-NO")}</p>
              </div>
              ${CONFIG.bookinglink ? `<a href="${CONFIG.bookinglink}" style="display:inline-block;margin-top:20px;background:#b8924a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;">Åpne booking</a>` : ''}
            </div>
          `
        }]
      })
    });
    console.log(`[EPOST] Bookingvarsel sendt til ${EPOST_TIL}`);
  } catch (err) {
    console.error("[FEIL] Kunne ikke sende e-post:", err.message);
  }
}


// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ── Middleware ────────────────────────────────────────────────────────────────

// Offentlige endepunkter (chat-widget kan kalles fra hvor som helst)
const corsPublic = cors({ origin: "*" });
// Sensitive endepunkter – bare fra samme opprinnelse eller kjente domener
const corsPrivat = cors({
  origin: (origin, callback) => {
    const tillatListe = [
      undefined,           // direkte server-til-server (ingen origin)
      "https://ai-chat-backend-6.onrender.com"
    ];
    if (!origin || tillatListe.includes(origin)) callback(null, true);
    else callback(new Error("CORS ikke tillatt"));
  }
});

app.use(express.json({ limit: "10kb" }));

// Enkel rate limiter (maks 20 req/min per IP)
const rateLimitMap = new Map();
// Rydd opp gamle IP-er hvert 5. minutt for å unngå memory leak
setInterval(() => {
  const grense = Date.now() - 60_000;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.start < grense) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

function lagRateLimit(maxRequests, prefix = "") {
  return function rateLimit(req, res, next) {
    const key = prefix + req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > 60_000) {
      entry.count = 1; entry.start = now;
    } else {
      entry.count++;
    }
    rateLimitMap.set(key, entry);
    if (entry.count > maxRequests) {
      return res.status(429).json({ ok: false, reply: "For mange foresporsler. Prov igjen om litt." });
    }
    next();
  };
}

const rateLimit      = lagRateLimit(20, "chat:");   // 20 chat-meldinger/min
const rateLimitBook  = lagRateLimit(5,  "book:");   // 5 bookinger/min (separat)

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", corsPublic, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/chat", corsPublic, (_req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});

app.get("/widget.js", corsPublic, (_req, res) => {
  res.sendFile(path.join(__dirname, "widget.js"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", bedrift: CONFIG.bedrift });
});

app.post("/chat", corsPublic, rateLimit, async (req, res) => {
  const { message, name, history = [] } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ reply: "Melding mangler eller er ugyldig." });
  }
  if (message.trim().length > 500) {
    return res.status(400).json({ reply: "Meldingen er for lang (maks 500 tegn)." });
  }
  if (!OPENAI_API_KEY) {
    console.error("[FEIL] OPENAI_API_KEY er ikke satt.");
    return res.status(500).json({ reply: "Konfigurasjonsfeil pa server." });
  }

  const safeName = name && typeof name === "string" ? name.slice(0, 50) : null;
  const systemContent = safeName
    ? `${SYSTEM_PROMPT}\n\nKundens navn: ${safeName}`
    : SYSTEM_PROMPT;

  const allowedRoles = new Set(["user", "assistant"]);
  const safeHistory = Array.isArray(history)
    ? history
        .filter(m => allowedRoles.has(m?.role) && typeof m?.content === "string")
        .slice(-14)          // behold 7 par (user+assistant) for god kontekst
        .map(m => ({ role: m.role, content: m.content.slice(0, 800) })) // litt mer plass til tids-kontekst
    : [];

  const messages = [
    { role: "system", content: systemContent },
    ...safeHistory,
    { role: "user", content: message.trim() },
  ];

  try {
    const aiCtrl    = new AbortController();
    const aiTimeout = setTimeout(() => aiCtrl.abort(), 12000); // 12 sek
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 300,
        temperature: 0.6,
      }),
      signal: aiCtrl.signal
    });
    clearTimeout(aiTimeout);

    if (!openaiRes.ok) {
      const errBody = await openaiRes.json().catch(() => ({}));
      console.error("[FEIL] OpenAI API-feil:", openaiRes.status, errBody);
      return res.status(502).json({ reply: "Kunne ikke na AI-tjenesten. Prov igjen." });
    }

    const data     = await openaiRes.json();
    const rawReply = data.choices?.[0]?.message?.content?.trim() ?? "Beklager, noe gikk galt.";

    const hasBookTag = rawReply.includes("[BOOK]");
    const reply      = rawReply.replace(/\[BOOK\]/g, "").trim();

    // Prøv å detektere om kunden oppga navnet sitt i denne meldingen
    // ved å sjekke om history er kort (tidlig i samtalen) og meldingen er kort
    let detektertNavn = null;
    if (!safeName && message.trim().split(" ").length <= 4 && message.trim().length <= 40) {
      // Enkel heuristikk: kort melding uten spørsmålstegn = sannsynlig navn
      const ingenSpm = !message.includes("?") && !message.includes("!");
      const ingenKw  = !["er", "har", "kan", "vil", "hva", "når", "hvor", "how", "what", "when"].some(w => message.toLowerCase().startsWith(w));
      if (ingenSpm && ingenKw) {
        // Normaliser: stor forbokstav, trim
        detektertNavn = message.trim().split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      }
    }

    // Hent dag og klokkeslett fra BRUKERENS melding (ikke AI-svaret)
    // slik at "torsdag 12:00" gir riktig filtrering
    let ledigeTider = null;
    if (hasBookTag) {
      console.log("[CAL] Henter ledige tider...");
      const onsketDag = parseDagFraMelding(message);
      const onsketTid = parseTidFraMelding(message);
      if (onsketDag) console.log("[CAL] Ønsket dag:", onsketDag.toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" }));
      if (onsketTid) console.log("[CAL] Ønsket tid:", onsketTid);
      ledigeTider = await hentLedigeTider(onsketDag, onsketTid);
      console.log("[CAL] Resultat:", ledigeTider ? ledigeTider.length + " tider" : "null");
    }

    // Vis fallback-knapp kun hvis Cal.com feilet helt (null), ikke ved tomme tider ([])
    const bookingUrl = hasBookTag && ledigeTider === null
      ? (CONFIG.bookinglink || null)
      : null;

    const logNavn = safeName ?? "Ukjent";
    const logMsg  = message.length > 80 ? message.slice(0, 80) + "…" : message;
    const logSvar = reply.length > 80   ? reply.slice(0, 80)   + "…" : reply;
    console.log(`[CHAT] [${new Date().toISOString()}] ${logNavn}: "${logMsg}" -> "${logSvar}" | tider: ${ledigeTider?.length ?? "null"}`);

    // Logging og e-post er ikke kritisk – kjør asynkront uten å blokkere svaret
    loggSamtale({ navn: safeName, melding: message, svar: reply, bookingVist: !!bookingUrl }).catch(() => {});
    if (bookingUrl) {
      sendBookingVarsel({ navn: safeName, melding: message }).catch(() => {});
    }

    return res.json({ reply, bookingUrl, ledigeTider, detektertNavn });

  } catch (error) {
    console.error("[FEIL] Nettverksfeil mot OpenAI:", error.message);
    return res.status(500).json({ reply: "Serverfeil. Prov igjen senere." });
  }
});

// ── /book – opprett Cal.com-booking direkte fra chatten ──────────────────────
app.post("/book", corsPublic, rateLimitBook, async (req, res) => {
  const { navn, epost, tid } = req.body;

  if (!navn || !epost || !tid) {
    return res.status(400).json({ ok: false, feil: "Navn, e-post og tidspunkt er påkrevd." });
  }
  if (typeof navn !== "string" || typeof epost !== "string" || typeof tid !== "string") {
    return res.status(400).json({ ok: false, feil: "Ugyldig datatype i forespørsel." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) {
    return res.status(400).json({ ok: false, feil: "Ugyldig e-postadresse." });
  }
  // Valider at tid er en gyldig ISO 8601-streng og i fremtiden
  const tidDato = new Date(tid);
  if (isNaN(tidDato.getTime()) || tidDato < new Date()) {
    return res.status(400).json({ ok: false, feil: "Ugyldig eller passert tidspunkt." });
  }

  const resultat = await opprettBooking({
    navn: navn.slice(0, 100),
    epost: epost.slice(0, 200),
    tid
  });

  if (!resultat.ok) {
    return res.status(502).json({ ok: false, feil: resultat.feil });
  }

  // Send bookingvarsel til salongen asynkront – ikke blokker svaret til kunden
  sendBookingVarsel({ navn, melding: `Ny booking: ${tid}` }).catch(() => {});

  return res.json({ ok: true });
});

// Dashboard data endpoint
app.post("/dashboard-data", corsPrivat, async (req, res) => {
  const { nokkel } = req.body;
  if (!nokkel) return res.status(400).json({ error: "Nokkel mangler." });
  try {
    const kundeRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/kunder?nokkel=eq.${encodeURIComponent(nokkel)}&select=*`,
      { headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const kunder = await kundeRes.json();
    if (!Array.isArray(kunder) || !kunder.length) return res.status(401).json({ error: "Feil nokkel." });

    const kunde = kunder[0];
    const samtaleRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/samtaler?bedrift=eq.${encodeURIComponent(kunde.bedrift)}&order=opprettet.desc&select=*`,
      { headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const samtaler = await samtaleRes.json();
    return res.json({ bedrift: kunde.bedrift, samtaler: Array.isArray(samtaler) ? samtaler : [] });
  } catch (err) {
    console.error("[FEIL] dashboard-data:", err.message);
    return res.status(500).json({ error: "Serverfeil. Prøv igjen." });
  }
});

// Slett samtale
app.delete("/slett-samtale", corsPrivat, async (req, res) => {
  const { id, nokkel } = req.body;
  if (!id || !nokkel) return res.status(400).json({ error: "Mangler id eller nokkel." });
  try {
    const kundeRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/kunder?nokkel=eq.${encodeURIComponent(nokkel)}&select=bedrift`,
      { headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const kunder = await kundeRes.json();
    if (!Array.isArray(kunder) || !kunder.length) return res.status(401).json({ error: "Ugyldig nokkel." });

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/samtaler?id=eq.${id}`, {
      method: "DELETE",
      headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` }
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[FEIL] slett-samtale:", err.message);
    return res.status(500).json({ error: "Serverfeil. Prøv igjen." });
  }
});

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Endepunkt ikke funnet." });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[SERVER] ${CONFIG.bedrift} kjorer pa port ${PORT}`);
});
