import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
// ── Les konfigurasjon ─────────────────────────────────────────────────────────
 
const CONFIG = JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf-8"));
 
function byggSystemPrompt(config) {
  const priser = config.priser?.join("\n  - ") || "Kontakt salongen for priser";
  const tjenester = config.tjenester?.join(", ") || "";
  const apningstider = Object.entries(config.apningstider || {})
    .map(([dag, tid]) => `  ${dag}: ${tid}`)
    .join("\n");
 
  return `Du er en ${config.tone || "vennlig og profesjonell"} kundeserviceassistent for ${config.bedrift}, en ${config.bransje}.
 
Retningslinjer:
- Svar alltid pa ${config.sprakOgLand || "norsk"}, kort og konkret (maks 3 setninger).
- Var varm og imotekommende - bruk kundens navn hvis du kjenner det.
- Hvis sporsmalet ikke er relevant for ${config.bransje}, avvis hoflig og hold deg til temaet.
- Ikke spekuler om tjenester du ikke kjenner til - be kunden kontakte oss.
- Du KAN IKKE booke timer selv. Du har ikke tilgang til kalenderen og kan ikke bekrefte eller reservere tider.
- Nar kunden spor om booking, ledig tid, vil bestille time, eller bekrefter at de vil booke: svar at de kan booke via lenken under, og avslutt svaret med [BOOK] pa en egen linje.
- Skriv ALDRI at du har booket, reservert eller bekreftet en time - det er ikke mulig.
 
Informasjon om ${config.bedrift}:
- Adresse: ${config.adresse || "Ikke oppgitt"}
- Telefon: ${config.telefon || "Ikke oppgitt"}
- E-post: ${config.epost || "Ikke oppgitt"}
 
Tjenester: ${tjenester}
 
Priser:
  - ${priser}
 
Apningstider:
${apningstider}`;
}
 
const SYSTEM_PROMPT = byggSystemPrompt(CONFIG);
 
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
 
app.get("/health", (_req, res) => {
  res.json({ status: "ok", bedrift: CONFIG.bedrift });
});
 
app.post("/chat", rateLimit, async (req, res) => {
  const { message, name, history = [] } = req.body;
 
  // Validering
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
 
  // Bygg meldinger
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
 
  // Kall OpenAI
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
 
    const data = await openaiRes.json();
    const rawReply = data.choices?.[0]?.message?.content?.trim() ?? "Beklager, noe gikk galt.";
 
    // Sjekk om AI vil vise bookingknapp
    const showBook = rawReply.includes("[BOOK]");
    const reply = rawReply.replace(/\[BOOK\]/g, "").trim();
    const bookingUrl = showBook ? (CONFIG.bookinglink || null) : null;
 
    console.log(`[CHAT] [${new Date().toISOString()}] ${safeName ?? "Ukjent"}: "${message}" -> "${reply}" ${showBook ? "[BOOK]" : ""}`);
 
    return res.json({ reply, bookingUrl });
 
  } catch (error) {
    console.error("[FEIL] Nettverksfeil mot OpenAI:", error.message);
    return res.status(500).json({ reply: "Serverfeil. Prov igjen senere." });
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
 
