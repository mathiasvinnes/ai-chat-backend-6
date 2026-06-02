(function () {
  // ── Tenant-slug (multi-tenant) ──────────────────────────────────────────────
  // Utled hvilken salong widgeten gjelder. Embed-koden kan sette window.SK_SLUG,
  // ellers leses ?salong= eller subdomene.
  function hentSlug() {
    if (window.SK_SLUG) return window.SK_SLUG;
    var p = new URLSearchParams(window.location.search).get("salong");
    if (p) return p;
    var vert = window.location.hostname.split(".");
    if (vert.length > 2 && vert[0] !== "www") return vert[0];
    return "";
  }
  // Hvor serveren ligger. Embed-koden kan sette window.SK_HOST (f.eks. for ekstern
  // nettside som laster widgeten fra ai-salong-serveren).
  var HOST = window.SK_HOST || window.location.origin;
  var SLUG = hentSlug();
  function medSlug(sti) {
    if (!SLUG) return HOST + sti;
    var skille = sti.indexOf("?") >= 0 ? "&" : "?";
    return HOST + sti + skille + "salong=" + encodeURIComponent(SLUG);
  }

  // ── Konfigurasjon (oppdateres fra /api/config) ──────────────────────────────
  var CONFIG = {
    apiUrl:      medSlug("/chat"),
    bookUrl:     medSlug("/book"),
    healthUrl:   medSlug("/health"),
    configUrl:   medSlug("/api/config"),
    bedrift:     "Salongen",
    initialer:   "AI",
    velkomst:    "Hei! Jeg er den automatiske assistenten. Spør meg om priser, behandlinger eller booking.",
    farge:       "#0d0d0d",
    aksentFarge: "#b8924a",
  };

  // ── Vekk serveren ──────────────────────────────────────────────────────────
  fetch(CONFIG.healthUrl).catch(function () {});

  // ── CSS ───────────────────────────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600&display=swap');",

    "#sk-widget-wrap * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'DM Sans', sans-serif; }",

    /* Boble-knapp */
    "#sk-bubble {",
    "  position: fixed; bottom: 24px; right: 24px; z-index: 99998;",
    "  width: 60px; height: 60px; border-radius: 50%;",
    "  background: " + CONFIG.farge + ";",
    "  box-shadow: 0 8px 32px rgba(0,0,0,0.22);",
    "  cursor: pointer; border: none;",
    "  display: flex; align-items: center; justify-content: center;",
    "  transition: transform 0.2s ease, box-shadow 0.2s ease;",
    "}",
    "#sk-bubble:hover { transform: scale(1.08); box-shadow: 0 12px 40px rgba(0,0,0,0.28); }",
    "#sk-bubble svg { transition: opacity 0.2s, transform 0.2s; }",
    "#sk-bubble.open .sk-icon-chat { opacity: 0; transform: scale(0.5); position: absolute; }",
    "#sk-bubble.open .sk-icon-close { opacity: 1; transform: scale(1); }",
    "#sk-bubble .sk-icon-close { opacity: 0; transform: scale(0.5); position: absolute; }",

    /* Varselpunkt */
    "#sk-badge {",
    "  position: absolute; top: -2px; right: -2px;",
    "  width: 16px; height: 16px; border-radius: 50%;",
    "  background: #e53e3e; border: 2px solid white;",
    "  animation: sk-pop 0.3s ease both;",
    "}",
    "@keyframes sk-pop { from { transform: scale(0); } to { transform: scale(1); } }",

    /* Chat-panel */
    "#sk-panel {",
    "  position: fixed; bottom: 96px; right: 24px; z-index: 99999;",
    "  width: 360px; height: 560px;",
    "  background: #fff;",
    "  border-radius: 20px;",
    "  box-shadow: 0 24px 64px rgba(0,0,0,0.18);",
    "  display: flex; flex-direction: column; overflow: hidden;",
    "  transform: scale(0.92) translateY(16px); opacity: 0; pointer-events: none;",
    "  transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s ease;",
    "  transform-origin: bottom right;",
    "}",
    "#sk-panel.open { transform: scale(1) translateY(0); opacity: 1; pointer-events: all; }",

    /* Header */
    "#sk-header {",
    "  background: " + CONFIG.farge + ";",
    "  padding: 16px 18px;",
    "  display: flex; align-items: center; gap: 12px;",
    "}",
    "#sk-avatar {",
    "  width: 38px; height: 38px; border-radius: 50%;",
    "  background: " + CONFIG.aksentFarge + ";",
    "  display: flex; align-items: center; justify-content: center;",
    "  font-family: 'DM Serif Display', serif;",
    "  font-size: 14px; color: #fff; flex-shrink: 0;",
    "}",
    "#sk-header-text h3 { color: #fff; font-size: 15px; font-weight: 600; }",
    "#sk-header-text p { color: rgba(255,255,255,0.55); font-size: 12px; margin-top: 2px; }",
    "#sk-live { margin-left: auto; display: flex; align-items: center; gap: 6px; color: rgba(255,255,255,0.7); font-size: 11px; }",
    "#sk-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; animation: sk-pulse 2s infinite; }",
    "@keyframes sk-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }",

    /* Meldinger */
    "#sk-messages {",
    "  flex: 1; overflow-y: auto; padding: 16px 14px;",
    "  display: flex; flex-direction: column; gap: 12px;",
    "  background: #f9f6f1;",
    "}",
    "#sk-messages::-webkit-scrollbar { width: 3px; }",
    "#sk-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }",

    ".sk-row { display: flex; gap: 8px; align-items: flex-end; animation: sk-fadeup 0.2s ease both; }",
    ".sk-row.user { flex-direction: row-reverse; }",
    "@keyframes sk-fadeup { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }",

    ".sk-av { width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;",
    "  display: flex; align-items: center; justify-content: center;",
    "  font-size: 10px; font-weight: 700; }",
    ".sk-av.bot { background: " + CONFIG.farge + "; color: " + CONFIG.aksentFarge + "; }",
    ".sk-av.user { background: #e2ddd6; color: #333; }",

    ".sk-bubble-msg { max-width: 78%; padding: 10px 13px; font-size: 13.5px; line-height: 1.55;",
    "  white-space: pre-wrap; word-break: break-word; }",
    ".sk-bubble-msg.bot { background: #fff; border: 1px solid #e8e2d9;",
    "  border-radius: 14px 14px 14px 4px; color: #1a1a1a; }",
    ".sk-bubble-msg.user { background: " + CONFIG.farge + "; color: #fff;",
    "  border-radius: 14px 14px 4px 14px; }",

    /* Typing */
    ".sk-typing { display: flex; gap: 5px; align-items: center; padding: 12px 14px;",
    "  background: #fff; border: 1px solid #e8e2d9; border-radius: 14px 14px 14px 4px; }",
    ".sk-typing span { display: block; width: 6px; height: 6px; border-radius: 50%;",
    "  background: #aaa; animation: sk-bounce 1.2s infinite; }",
    ".sk-typing span:nth-child(2){animation-delay:0.2s}",
    ".sk-typing span:nth-child(3){animation-delay:0.4s}",
    "@keyframes sk-bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }",

    /* Composer */
    "#sk-composer { background: #fff; border-top: 1px solid #ede8df; padding: 12px; display: flex; gap: 8px; align-items: flex-end; }",
    "#sk-input {",
    "  flex: 1; border: 1px solid #ddd; border-radius: 12px;",
    "  padding: 9px 12px; font-size: 13.5px; color: #1a1a1a;",
    "  background: #f9f6f1; resize: none; max-height: 100px;",
    "  font-family: 'DM Sans', sans-serif; line-height: 1.4;",
    "  transition: border-color 0.15s;",
    "}",
    "#sk-input:focus { outline: none; border-color: " + CONFIG.aksentFarge + "; }",
    "#sk-input::placeholder { color: #aaa; }",
    "#sk-send {",
    "  width: 38px; height: 38px; border-radius: 50%; border: none;",
    "  background: " + CONFIG.farge + "; color: #fff; cursor: pointer;",
    "  display: flex; align-items: center; justify-content: center;",
    "  flex-shrink: 0; transition: background 0.15s, transform 0.07s;",
    "}",
    "#sk-send:hover { background: #2a2a2a; }",
    "#sk-send:active { transform: scale(0.93); }",
    "#sk-send:disabled { opacity: 0.4; cursor: not-allowed; }",

    ".sk-book-btn {",
    "  display: inline-block;",
    "  background: " + CONFIG.aksentFarge + ";",
    "  color: #fff !important;",
    "  font-family: 'DM Sans', sans-serif;",
    "  font-size: 13.5px; font-weight: 600;",
    "  padding: 11px 24px;",
    "  border-radius: 999px;",
    "  text-decoration: none;",
    "  cursor: pointer;",
    "  transition: opacity 0.15s, transform 0.1s;",
    "  animation: sk-fadeup 0.2s ease both;",
    "  margin-top: 4px;",
    "  box-shadow: 0 4px 14px rgba(0,0,0,0.15);",
    "}",
    ".sk-book-btn:hover { opacity: 0.88; transform: translateY(-1px); }",
    "@media (max-width: 420px) {",
    "  #sk-panel { width: calc(100vw - 24px); right: 12px; bottom: 88px; }",
    "  #sk-bubble { right: 12px; bottom: 12px; }",
    "}",
  ].join("\n");
  document.head.appendChild(style);

  // ── HTML ──────────────────────────────────────────────────────────────────
  var wrap = document.createElement("div");
  wrap.id = "sk-widget-wrap";
  wrap.innerHTML = [
    /* Panel */
    '<div id="sk-panel">',
    '  <div id="sk-header">',
    '    <div id="sk-avatar">AI</div>',
    '    <div id="sk-header-text">',
    '      <h3>' + CONFIG.bedrift + '</h3>',
    '      <p>AI-assistent</p>',
    '    </div>',
    '    <div id="sk-live"><span id="sk-live-dot"></span> Live</div>',
    '  </div>',
    '  <div id="sk-messages"></div>',
    '  <div id="sk-composer">',
    '    <textarea id="sk-input" rows="1" placeholder="Skriv en melding..."></textarea>',
    '    <button id="sk-send" aria-label="Send">',
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
    '        <line x1="22" y1="2" x2="11" y2="13"></line>',
    '        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>',
    '      </svg>',
    '    </button>',
    '  </div>',
    '</div>',

    /* Boble */
    '<button id="sk-bubble" aria-label="Aapne chat">',
    '  <span id="sk-badge" style="display:none"></span>',
    '  <svg class="sk-icon-chat" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
    '  </svg>',
    '  <svg class="sk-icon-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round">',
    '    <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    '  </svg>',
    '</button>',
  ].join("");
  document.body.appendChild(wrap);

  // ── State ─────────────────────────────────────────────────────────────────
  var isOpen    = false;
  var isLocked  = false;
  var history   = [];
  var welcomed  = false;

  // ── Referanser ────────────────────────────────────────────────────────────
  var panel    = document.getElementById("sk-panel");
  var bubble   = document.getElementById("sk-bubble");
  var badge    = document.getElementById("sk-badge");
  var messages = document.getElementById("sk-messages");
  var input    = document.getElementById("sk-input");
  var sendBtn  = document.getElementById("sk-send");

  // ── Hjelpere ──────────────────────────────────────────────────────────────
  function addMessage(role, text) {
    var row = document.createElement("div");
    row.className = "sk-row " + role;

    var av = document.createElement("div");
    av.className = "sk-av " + role;
    av.textContent = role === "user" ? "Deg" : CONFIG.initialer;

    var bbl = document.createElement("div");
    bbl.className = "sk-bubble-msg " + role;
    bbl.textContent = text;

    if (role === "user") { row.appendChild(bbl); row.appendChild(av); }
    else                 { row.appendChild(av);  row.appendChild(bbl); }

    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }


  function addBookingButton(url) {
    var row = document.createElement("div");
    row.className = "sk-row";
    row.style.paddingLeft = "38px";

    var btn = document.createElement("a");
    btn.href = url;
    btn.target = "_blank";
    btn.rel = "noopener noreferrer";
    btn.className = "sk-book-btn";
    btn.textContent = "Book time";

    row.appendChild(btn);
    messages.appendChild(row);
    // Scroll multiple times to ensure button is always visible
    messages.scrollTop = messages.scrollHeight;
    setTimeout(function() { messages.scrollTop = messages.scrollHeight; }, 50);
    setTimeout(function() { messages.scrollTop = messages.scrollHeight; }, 150);
  }

  function visLedigeTider(tider) {
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;padding-left:38px;margin-top:4px;";
    tider.forEach(function(t) {
      var btn = document.createElement("button");
      btn.textContent = t.visning;
      btn.style.cssText = [
        "display:inline-block","background:#f9f6f1","border:1px solid #e8e2d9",
        "color:#0d0d0d","font-family:'DM Sans',sans-serif","font-size:13px","font-weight:500",
        "padding:9px 16px","border-radius:10px","text-align:left","cursor:pointer","width:fit-content",
        "transition:background 0.15s,color 0.15s"
      ].join(";");
      btn.onmouseover = function() { btn.style.background = CONFIG.aksentFarge; btn.style.color = "#fff"; };
      btn.onmouseout  = function() { btn.style.background = "#f9f6f1"; btn.style.color = "#0d0d0d"; };
      btn.addEventListener("click", function() { startBooking(t, wrap); });
      wrap.appendChild(btn);
    });
    messages.appendChild(wrap);
    setTimeout(function() { messages.scrollTop = messages.scrollHeight; }, 50);
    setTimeout(function() { messages.scrollTop = messages.scrollHeight; }, 150);
  }

  // Samle inn navn + e-post i chatten, deretter book via /book
  function startBooking(t, slotWrap) {
    slotWrap.querySelectorAll("button").forEach(function(b) {
      b.disabled = true; b.style.opacity = "0.4"; b.style.cursor = "not-allowed";
    });
    var form = document.createElement("div");
    form.style.cssText = "display:flex;flex-direction:column;gap:8px;padding-left:38px;margin-top:6px;";
    form.innerHTML = [
      '<input class="sk-book-felt" type="text" placeholder="Navn" style="border:1px solid #ddd;border-radius:10px;padding:9px 12px;font-size:13px;font-family:inherit;">',
      '<input class="sk-book-felt" type="email" placeholder="E-post" style="border:1px solid #ddd;border-radius:10px;padding:9px 12px;font-size:13px;font-family:inherit;">'
    ].join("");
    var bekreft = document.createElement("button");
    bekreft.textContent = "Bekreft booking " + t.visning;
    bekreft.style.cssText = "background:" + CONFIG.aksentFarge + ";color:#fff;border:none;border-radius:999px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;";
    form.appendChild(bekreft);
    messages.appendChild(form);
    messages.scrollTop = messages.scrollHeight;
    var felter = form.querySelectorAll(".sk-book-felt");
    felter[0].focus();

    bekreft.addEventListener("click", async function() {
      var navn  = felter[0].value.trim();
      var epost = felter[1].value.trim();
      if (!navn || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) {
        if (!navn) felter[0].style.borderColor = "#e05";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) felter[1].style.borderColor = "#e05";
        return;
      }
      bekreft.disabled = true; bekreft.textContent = "Booker...";
      try {
        var res = await fetch(CONFIG.bookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ navn: navn, epost: epost, tid: t.tid })
        });
        var data = await res.json();
        form.remove();
        if (data.ok) {
          addMessage("bot", "✅ Time booket! Bekreftelse er sendt til " + epost + ". Vi sees " + t.visning + "! 🎉");
        } else {
          addMessage("bot", "Noe gikk galt: " + (data.feil || "prøv igjen eller ring oss."));
          slotWrap.querySelectorAll("button").forEach(function(b) {
            b.disabled = false; b.style.opacity = "1"; b.style.cursor = "pointer";
          });
        }
      } catch (e) {
        form.remove();
        addMessage("bot", "Kunne ikke fullføre bookingen. Prøv igjen eller ring oss.");
        slotWrap.querySelectorAll("button").forEach(function(b) {
          b.disabled = false; b.style.opacity = "1"; b.style.cursor = "pointer";
        });
      }
    });
  }

  function showTyping() {
    var row = document.createElement("div");
    row.className = "sk-row"; row.id = "sk-typing-row";
    var av = document.createElement("div");
    av.className = "sk-av bot"; av.textContent = CONFIG.initialer;
    var t = document.createElement("div");
    t.className = "sk-typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    row.appendChild(av); row.appendChild(t);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById("sk-typing-row");
    if (t) t.remove();
  }

  function setLocked(v) {
    isLocked = v;
    sendBtn.disabled = v;
    input.readOnly = v;
  }

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 100) + "px";
  }

  // ── Hent salong-config og oppdater dynamisk innhold ─────────────────────────
  fetch(CONFIG.configUrl)
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(cfg) {
      if (!cfg || !cfg.bedrift) return;
      CONFIG.bedrift = cfg.bedrift;
      CONFIG.initialer = cfg.bedrift.split(" ").map(function(w){return w[0];}).join("").slice(0,2).toUpperCase();
      if (cfg.velkomst) CONFIG.velkomst = cfg.velkomst;
      if (cfg.bookinglink) CONFIG.bookinglink = cfg.bookinglink;
      // Oppdater synlige elementer
      var h3 = document.querySelector("#sk-header-text h3");
      if (h3) h3.textContent = cfg.bedrift;
      var avatar = document.getElementById("sk-avatar");
      if (avatar) avatar.textContent = CONFIG.initialer;
      document.querySelectorAll(".sk-av.bot").forEach(function(el){ el.textContent = CONFIG.initialer; });
      // Farger
      if (cfg.farge && /^#[0-9a-fA-F]{6}$/.test(cfg.farge)) {
        CONFIG.aksentFarge = cfg.farge;
      }
    })
    .catch(function(){});

  // ── Toggle panel ──────────────────────────────────────────────────────────
  function togglePanel() {
    isOpen = !isOpen;
    panel.classList.toggle("open", isOpen);
    bubble.classList.toggle("open", isOpen);
    badge.style.display = "none";

    if (isOpen && !welcomed) {
      welcomed = true;
      setTimeout(function () { addMessage("bot", CONFIG.velkomst); }, 300);
    }
    if (isOpen) setTimeout(function () { input.focus(); }, 300);
  }

  bubble.addEventListener("click", togglePanel);

  // Vis varselpunkt etter 4 sek
  setTimeout(function () {
    if (!isOpen) badge.style.display = "block";
  }, 4000);

  // ── Send melding ──────────────────────────────────────────────────────────
  async function send() {
    var text = input.value.trim();
    if (!text || isLocked) return;

    addMessage("user", text);
    history.push({ role: "user", content: text });
    input.value = "";
    input.style.height = "auto";
    setLocked(true);
    showTyping();

    try {
      var res = await fetch(CONFIG.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history })
      });

      removeTyping();

      if (!res.ok) throw new Error("HTTP " + res.status);

      var data  = await res.json();
      var reply = data.reply || "Beklager, noe gikk galt.";
      addMessage("bot", reply);
      if (data.ledigeTider && data.ledigeTider.length > 0) {
        visLedigeTider(data.ledigeTider);
      } else if (data.bookingUrl) {
        addBookingButton(data.bookingUrl);
      }
      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history = history.slice(-20);

    } catch (err) {
      removeTyping();
      addMessage("bot", "Kunne ikke na serveren. Provigjen senere.");
    } finally {
      setLocked(false);
      input.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", autoResize);

})();
