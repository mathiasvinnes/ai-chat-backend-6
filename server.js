import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
 
// ── Middleware ────────────────────────────────────────────────────────────────
 
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10kb" })); // Prevent oversized payloads
 
// Simple in-memory rate limiter (per IP, max 20 req/min)
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
    return res.status(429).json({ reply: "For mange forespørsler. Prøv igjen om litt." });
  }
  next();
}
 
// ── System prompt ─────────────────────────────────────────────────────────────
 
const SYSTEM_PROMPT = `Du er en profesjonell og vennlig kundeserviceassistent for en frisørsalong.
 
Retningslinjer:
- Svar alltid på norsk, kort og konkret (maks 3 setninger).
- Vær varm og imøtekommende – bruk kundens navn hvis du kjenner det.
- Inviter alltid kunden til å booke time når det er naturlig.
- Hvis spørsmålet ikke er relevant for salongen, avvis høflig og hold deg til temaet.
- Ikke spekuler om priser eller tjenester du ikke kjenner til – be kunden kontakte salongen.`;
 
// ── Routes ────────────────────────────────────────────────────────────────────
 
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});
 
app.get("/health", (_req, res) => {
  res.json({ status: "ok", message: "AI chat backend kjører ✅" });
});
 
app.post("/chat", rateLimit, async (req, res) => {
  const { message, name, history = [] } = req.body;
 
  // --- Validation ---
  if (!message || typeof message !== "string") {
    return res.status(400).json({ reply: "Melding mangler eller er ugyldig." });
  }
  if (message.trim().length > 500) {
    return res.status(400).json({ reply: "Meldingen er for lang (maks 500 tegn)." });
  }
  if (!OPENAI_API_KEY) {
    console.error("[FEIL] OPENAI_API_KEY er ikke satt.");
    return res.status(500).json({ reply: "Konfigurasjonsfeil på server." });
  }
 
  // --- Build conversation messages ---
  const safeName = name && typeof name === "string" ? name.slice(0, 50) : null;
  const systemContent = safeName
    ? `${SYSTEM_PROMPT}\n\nKundens navn: ${safeName}`
    : SYSTEM_PROMPT;
 
  // Support optional conversation history for multi-turn chat
  const allowedRoles = new Set(["user", "assistant"]);
  const safeHistory = Array.isArray(history)
    ? history
        .filter(m => allowedRoles.has(m?.role) && typeof m?.content === "string")
        .slice(-10) // keep last 10 turns max
        .map(m => ({ role: m.role, content: m.content.slice(0, 500) }))
    : [];
 
  const messages = [
    { role: "system", content: systemContent },
    ...safeHistory,
    { role: "user", content: message.trim() },
  ];
 
  // --- Call OpenAI chat completions ---
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
      return res.status(502).json({ reply: "Kunne ikke nå AI-tjenesten. Prøv igjen." });
    }
 
    const data = await openaiRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "Beklager, noe gikk galt.";
 
    console.log(`[CHAT] [${new Date().toISOString()}] ${safeName ?? "Ukjent"}: "${message}" -> "${reply}"`);
 
    return res.json({ reply });
 
  } catch (error) {
    console.error("[FEIL] Nettverksfeil mot OpenAI:", error.message);
    return res.status(500).json({ reply: "Serverfeil. Prøv igjen senere." });
  }
});
 
// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Endepunkt ikke funnet." });
});
 
// ── Start ─────────────────────────────────────────────────────────────────────
 
app.listen(PORT, () => {
  console.log(`[SERVER] Kjorer pa port ${PORT}`);
});
 rer på port ${PORT}`);
});
