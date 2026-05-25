import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Les konfigurasjon ─────────────────────────────────────────────────────────

const CONFIG = JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf-8"));

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
- Du KAN vise ledige tider - disse hentes automatisk fra kalenderen og vises under svaret ditt som klikkbare knapper.
- Du KAN IKKE bekrefte, reservere eller booke tider direkte - kunden klikker pa en ledig tid for a ga videre.
- Nar kunden spor om booking, ledig tid, eller vil bestille time: si at du henter ledige tider, og avslutt ALLTID med [BOOK] pa en helt egen linje.
- Eksempel: "Her er ledige tider for deg denne uken:\n[BOOK]"
- Skriv ALDRI at du ikke har tilgang til kalenderen - du kan alltid hente og vise ledige tider.
- Skriv ALDRI at du har booket eller bekreftet en time - kunden klikker selv pa tidspunktet.

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

const CAL_API_KEY      = process.env.CAL_API_KEY;
const CAL_EVENT_TYPE_ID = Number(process.env.CAL_EVENT_TYPE_ID);
const CAL_BASE         = "https://api.cal.com/v2";

// Parser hvilken dag brukeren spør om
function parseDagFraMelding(melding) {
  const lower = melding.toLowerCase();
  if (/\bi dag\b|\bidag\b/.test(lower)) return new Date();
  if (/\bi morgen\b|\bimorgen\b/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() + 1); return d;
  }
  const dagMap = { mandag:1, tirsdag:2, onsdag:3, torsdag:4, fredag:5, lordag:6, "l\u00f8rdag":6, sondag:0, "s\u00f8ndag":0 };
  for (const [navn, nr] of Object.entries(dagMap)) {
    if (lower.includes(navn)) {
      const na = new Date();
      let diff = nr - na.getDay();
      if (diff <= 0) diff += 7;
      const dato = new Date(na);
      dato.setDate(na.getDate() + diff);
      return dato;
    }
  }
  return null;
}

async function hentLedigeTider(onsketDag = null) {
  if (!CAL_API_KEY || !CAL_EVENT_TYPE_ID) return null;
  try {
    const now  = new Date(Date.now() + 5 * 60 * 1000);
    const slutt = new Date(now);
    slutt.setDate(slutt.getDate() + 7);

    const url = `${CAL_BASE}/slots/available` +
      `?eventTypeId=${CAL_EVENT_TYPE_ID}` +
      `&startTime=${now.toISOString()}` +
      `&endTime=${slutt.toISOString()}` +
      `&timeZone=Europe/Oslo`;

    const res  = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${CAL_API_KEY}`,
        "cal-api-version": "2024-08-13"
      }
    });
    const data = await res.json();

    // MIDLERTIDIG DEBUG
    console.log("[CAL DEBUG] HTTP status:", res.status);
    console.log("[CAL DEBUG] Råsvar:", JSON.stringify(data).slice(0, 600));

    if (data.status !== "success") {
      console.error("[CAL] Feil fra API:", JSON.stringify(data));
      return null;
    }

    // Flatt ut slots-objektet { "2024-08-26": [{time:...}, ...], ... }
    const slots = data.data?.slots || {};
    const alle  = Object.entries(slots).flatMap(([dag, tider]) =>
      tider.map(t => ({ dag, tid: t.time }))
    );

    if (alle.length === 0) {
      console.warn("[CAL] 0 ledige tider returnert");
      return null;
    }

    let utvalg;

    if (onsketDag) {
      const onsketStr = onsketDag.toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" });
      utvalg = alle.filter(t =>
        new Date(t.tid).toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" }) === onsketStr
      ).slice(0, 6);
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
      })
    });
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
                <p><strong>Navn:</strong> ${navn || "Ukjent"}</p>
                <p><strong>Melding:</strong> ${melding}</p>
                <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString("no-NO")}</p>
              </div>
              <a href="${CONFIG.bookinglink}" style="display:inline-block;margin-top:20px;background:#b8924a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;">
                Åpne booking
              </a>
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

// Bekreftelsesepost til kunden etter at Calendly-webhook bekrefter booking
async function sendBekreftelse({ navn, epost, tid }) {
  if (!SENDGRID_KEY || !epost) return;
  const tidFormatert = tid
    ? new Date(tid).toLocaleString("no-NO", {
        weekday: "long", day: "numeric", month: "long",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo"
      })
    : "Ukjent tidspunkt";

  try {
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: epost }] }],
        from: { email: EPOST_FRA, name: CONFIG.bedrift },
        subject: `Bookingbekreftelse – ${CONFIG.bedrift}`,
        content: [{
          type: "text/html",
          value: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9f6f1;border-radius:12px;">
              <h2 style="color:#0d0d0d;margin-bottom:8px;">Booking bekreftet! ✅</h2>
              <p style="color:#666;margin-bottom:20px;">Hei ${navn || ""}! Vi gleder oss til å se deg.</p>
              <div style="background:#fff;border-radius:8px;padding:16px;border:1px solid #e8e2d9;">
                <p><strong>Salong:</strong> ${CONFIG.bedrift}</p>
                <p><strong>Adresse:</strong> ${CONFIG.adresse || "Se nettside"}</p>
                <p><strong>Tidspunkt:</strong> ${tidFormatert}</p>
              </div>
              <p style="margin-top:20px;color:#666;font-size:13px;">
                Trenger du å avbestille eller endre timen? Ring oss på ${CONFIG.telefon || CONFIG.epost}.
              </p>
            </div>
          `
        }]
      })
    });
    console.log(`[EPOST] Bekreftelse sendt til ${epost}`);
  } catch (err) {
    console.error("[FEIL] Kunne ikke sende bekreftelse:", err.message);
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10kb" }));

// Enkel rate limiter (maks 20 req/min per IP)
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 20;

  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);

  if (entry.count > maxRequests) {
    return res.status(429).json({ reply: "For mange foresporsler. Prov igjen om litt." });
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});

app.get("/widget.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "widget.js"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", bedrift: CONFIG.bedrift });
});

// ── Calendly webhook – mottar bekreftelse når kunde booker ───────────────────
app.post("/webhook/calendly", async (req, res) => {
  res.json({ ok: true }); // svar raskt til Calendly

  try {
    const event = req.body;
    console.log("[WEBHOOK] Calendly event:", event?.event);

    if (event?.event === "invitee.created") {
      const invitee  = event.payload?.invitee;
      const navn     = invitee?.name;
      const epost    = invitee?.email;
      const tid      = event.payload?.event?.start_time;

      console.log(`[WEBHOOK] Ny booking: ${navn} (${epost}) – ${tid}`);
      await sendBekreftelse({ navn, epost, tid });
    }
  } catch (err) {
    console.error("[WEBHOOK] Feil:", err.message);
  }
});

app.post("/chat", rateLimit, async (req, res) => {
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
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content.slice(0, 500) }))
    : [];

  const messages = [
    { role: "system", content: systemContent },
    ...safeHistory,
    { role: "user", content: message.trim() },
  ];

  try {
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
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.json().catch(() => ({}));
      console.error("[FEIL] OpenAI API-feil:", openaiRes.status, errBody);
      return res.status(502).json({ reply: "Kunne ikke na AI-tjenesten. Prov igjen." });
    }

    const data     = await openaiRes.json();
    const rawReply = data.choices?.[0]?.message?.content?.trim() ?? "Beklager, noe gikk galt.";

    const hasBookTag      = rawReply.includes("[BOOK]");
    const bookingKeywords = ["book", "bestill", "time", "ledig", "reserv", "plass", "avtale", "nar kan", "naar kan", "naar", "when"];
    const userWantsBooking = bookingKeywords.some(kw => message.toLowerCase().includes(kw));
    const reply = rawReply.replace(/\[BOOK\]/g, "").trim();

    let ledigeTider = null;
    if (hasBookTag || userWantsBooking) {
      console.log("[CAL] Henter ledige tider...");
      const onsketDag = parseDagFraMelding(message);
      if (onsketDag) {
        console.log("[CAL] Ønsket dag:", onsketDag.toLocaleDateString("no-NO", { timeZone: "Europe/Oslo" }));
      }
      ledigeTider = await hentLedigeTider(onsketDag);
      console.log("[CAL] Resultat:", ledigeTider ? ledigeTider.length + " tider" : "null");
    }

    const bookingUrl = (hasBookTag || userWantsBooking) ? (CONFIG.bookinglink || null) : null;

    console.log(`[CHAT] [${new Date().toISOString()}] ${safeName ?? "Ukjent"}: "${message}" -> "${reply}" ${hasBookTag ? "[BOOK]" : ""}`);

    loggSamtale({ navn: safeName, melding: message, svar: reply, bookingVist: !!bookingUrl });

    if (bookingUrl) {
      sendBookingVarsel({ navn: safeName, melding: message });
    }

    return res.json({ reply, bookingUrl, ledigeTider });

  } catch (error) {
    console.error("[FEIL] Nettverksfeil mot OpenAI:", error.message);
    return res.status(500).json({ reply: "Serverfeil. Prov igjen senere." });
  }
});

// ── /book – opprett Cal.com-booking direkte fra chatten ──────────────────────
app.post("/book", rateLimit, async (req, res) => {
  const { navn, epost, tid } = req.body;

  if (!navn || !epost || !tid) {
    return res.status(400).json({ ok: false, feil: "Navn, e-post og tidspunkt er påkrevd." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) {
    return res.status(400).json({ ok: false, feil: "Ugyldig e-postadresse." });
  }

  const resultat = await opprettBooking({
    navn: navn.slice(0, 100),
    epost: epost.slice(0, 200),
    tid
  });

  if (!resultat.ok) {
    return res.status(502).json({ ok: false, feil: resultat.feil });
  }

  // Send bookingvarsel til salongen
  sendBookingVarsel({ navn, melding: `Ny booking: ${tid}` });

  return res.json({ ok: true });
});

// Dashboard data endpoint
app.post("/dashboard-data", async (req, res) => {
  const { nokkel } = req.body;
  if (!nokkel) return res.status(400).json({ error: "Nokkel mangler." });

  const kundeRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/kunder?nokkel=eq.${encodeURIComponent(nokkel)}&select=*`,
    { headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` } }
  );
  const kunder = await kundeRes.json();
  if (!kunder.length) return res.status(401).json({ error: "Feil nokkel." });

  const kunde = kunder[0];
  const samtaleRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/samtaler?bedrift=eq.${encodeURIComponent(kunde.bedrift)}&order=opprettet.desc&select=*`,
    { headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` } }
  );
  const samtaler = await samtaleRes.json();
  return res.json({ bedrift: kunde.bedrift, samtaler });
});

// Slett samtale
app.delete("/slett-samtale", async (req, res) => {
  const { id, nokkel } = req.body;
  if (!id || !nokkel) return res.status(400).json({ error: "Mangler id eller nokkel." });

  const kundeRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/kunder?nokkel=eq.${encodeURIComponent(nokkel)}&select=bedrift`,
    { headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` } }
  );
  const kunder = await kundeRes.json();
  if (!kunder.length) return res.status(401).json({ error: "Ugyldig nokkel." });

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/samtaler?id=eq.${id}`, {
    method: "DELETE",
    headers: { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` }
  });

  return res.json({ ok: true });
});

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Endepunkt ikke funnet." });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[SERVER] ${CONFIG.bedrift} kjorer pa port ${PORT}`);
});
