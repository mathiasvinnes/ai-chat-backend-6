(function () {
  // ── Konfigurasjon ──────────────────────────────────────────────────────────
  var CONFIG = {
    apiUrl:      "https://ai-chat-backend-6.onrender.com/chat",
    healthUrl:   "https://ai-chat-backend-6.onrender.com/health",
    bedrift:     "Studio Klipp",
    velkomst:    "Hei! Jeg er den automatiske assistenten. Spør meg om priser, behandlinger eller booking.",
    farge:       "#0d0d0d",      // hovedfarge (boble og header)
    aksentFarge: "#b8924a",      // gullaksent
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
    '    <div id="sk-avatar">SK</div>',
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
    av.textContent = role === "user" ? "Deg" : "SK";

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
    setTimeout(function() {
      messages.scrollTop = messages.scrollHeight;
    }, 50);
  }

  function showTyping() {
    var row = document.createElement("div");
    row.className = "sk-row"; row.id = "sk-typing-row";
    var av = document.createElement("div");
    av.className = "sk-av bot"; av.textContent = "SK";
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
      if (data.bookingUrl) addBookingButton(data.bookingUrl);
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
