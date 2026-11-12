/* Palavra — Estúdio de gravação e transcrição
 * Gravação: MediaRecorder · Transcrição ao vivo: Web Speech API
 * Armazenamento: IndexedDB (no próprio navegador)
 */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------- Elementos ----------
  const el = {
    title: $("#inTitle"), speaker: $("#inSpeaker"), kind: $("#inKind"), lang: $("#inLang"),
    status: $("#status"), saveState: $("#saveState"), timer: $("#timer"), wave: $("#wave"),
    rec: $("#btnRec"), stop: $("#btnStop"), para: $("#btnPara"), hint: $("#hint"),
    player: $("#player"), paras: $("#paras"), interim: $("#interim"), empty: $("#empty"),
    doc: $("#doc"), docKind: $("#docKind"), docTitle: $("#docTitle"), docBy: $("#docBy"),
    words: $("#stWords"), count: $("#stParas"),
    optPunct: $("#optPunct"), optTs: $("#optTs"), optGap: $("#optGap"), gapVal: $("#gapVal"),
    copy: $("#btnCopy"), exportBtn: $("#btnExport"), exportMenu: $("#exportMenu"),
    btnNew: $("#btnNew"), btnHistory: $("#btnHistory"), drawer: $("#drawer"),
    closeDrawer: $("#btnCloseDrawer"), list: $("#sessionList"), toast: $("#toast"),
    unsupported: $("#unsupported"),
  };

  // ---------- Estado ----------
  const MAX_WORDS_PER_PARA = 110;
  let session = blankSession();
  let status = "idle"; // idle | recording | paused | stopped
  let startedAt = 0;   // performance.now() do último início/retomada
  let elapsedBefore = 0;
  let lastFinalAt = -Infinity;
  let utteranceStart = null; // quando começou a fala atual (primeiro resultado parcial)
  let forceNewPara = false;

  let stream = null, recorder = null, chunks = [], mime = "";
  let audioCtx = null, analyser = null, rafId = 0;
  let recog = null, wantListening = false;
  let wakeLock = null;
  let audioURL = null;

  function blankSession() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "", speaker: "", kind: "Pregação", lang: "pt-BR",
      createdAt: new Date().toISOString(), duration: 0,
      paragraphs: [], audio: null, mime: "",
    };
  }

  const elapsed = () => status === "recording" ? elapsedBefore + (performance.now() - startedAt) : elapsedBefore;

  // ---------- Utilidades ----------
  function fmtTime(ms, withMs = false) {
    const t = Math.max(0, Math.floor(ms));
    const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60;
    const base = [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
    return withMs ? `${base},${String(t % 1000).padStart(3, "0")}` : base;
  }
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const countWords = (s) => (s.match(/\S+/g) || []).length;

  function fmtChunk(raw) {
    let t = raw.trim().replace(/\s+/g, " ");
    if (!el.optPunct.checked || !t) return t;
    t = t.charAt(0).toLocaleUpperCase() + t.slice(1);
    if (!/[.!?…:;,]$/.test(t)) t += ".";
    return t;
  }
  const paraText = (p) => p.edited ?? p.chunks.map((c) => fmtChunk(c.raw)).join(" ");

  let toastTimer;
  function toast(msg, ms = 3200) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
  }

  function slug(s) {
    return (s || "transcricao").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "transcricao";
  }
  function fileBase() {
    return `${slug(session.title)}-${session.createdAt.slice(0, 10)}`;
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- IndexedDB ----------
  const DB = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("palavra-estudio", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sessions", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("sessions", mode);
        const req = fn(t.objectStore("sessions"));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (o) => tx("readwrite", (s) => s.put(o)),
      get: (id) => tx("readonly", (s) => s.get(id)),
      all: () => tx("readonly", (s) => s.getAll()),
      del: (id) => tx("readwrite", (s) => s.delete(id)),
    };
  })();

  let saveTimer;
  function scheduleSave(delay = 1500) {
    clearTimeout(saveTimer);
    el.saveState.textContent = "salvando…";
    saveTimer = setTimeout(save, delay);
  }
  async function save() {
    clearTimeout(saveTimer);
    syncMeta();
    if (!session.paragraphs.length && !session.audio) { el.saveState.textContent = ""; return; }
    session.duration = Math.max(session.duration, elapsed());
    try {
      await DB.put(session);
      el.saveState.textContent = "salvo";
    } catch (e) {
      console.error(e);
      el.saveState.textContent = "erro ao salvar";
    }
  }

  // ---------- Metadados ----------
  function syncMeta() {
    session.title = el.title.value.trim();
    session.speaker = el.speaker.value.trim();
    session.kind = el.kind.value;
    session.lang = el.lang.value;
    el.docTitle.textContent = session.title || "Sem título";
    el.docKind.textContent = `${session.kind} · ${new Date(session.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}`;
    el.docBy.textContent = session.speaker ? session.speaker : "";
    document.title = (session.title ? session.title + " · " : "") + "Palavra";
  }
  [el.title, el.speaker].forEach((i) => i.addEventListener("input", () => { syncMeta(); scheduleSave(); }));
  [el.kind, el.lang].forEach((i) => i.addEventListener("change", () => {
    syncMeta(); scheduleSave();
    if (i === el.lang && status === "recording") { stopRecognition(); startRecognition(); }
  }));

  // ---------- Renderização da transcrição ----------
  function paraNode(p) {
    let node = el.paras.querySelector(`[data-id="${p.id}"]`);
    if (node) return node;
    node = document.createElement("div");
    node.className = "para fresh";
    node.dataset.id = p.id;
    const ts = document.createElement("button");
    ts.className = "ts";
    ts.type = "button";
    ts.textContent = fmtTime(p.start);
    ts.addEventListener("click", () => seek(p.start));
    const txt = document.createElement("p");
    try { txt.contentEditable = "plaintext-only"; } catch { txt.contentEditable = "true"; }
    if (txt.contentEditable !== "plaintext-only") txt.contentEditable = "true";
    txt.spellcheck = true;
    txt.addEventListener("input", () => {
      p.edited = txt.innerText.replace(/\n+/g, " ").trim();
      updateStats(); scheduleSave();
    });
    txt.addEventListener("blur", () => {
      if (!txt.innerText.trim()) { // parágrafo apagado pelo usuário
        session.paragraphs = session.paragraphs.filter((x) => x !== p);
        node.remove(); updateStats(); scheduleSave();
      }
    });
    node.append(ts, txt);
    el.paras.appendChild(node);
    setTimeout(() => node.classList.remove("fresh"), 700);
    return node;
  }
  function renderPara(p) {
    const node = paraNode(p);
    const txt = node.querySelector("p");
    if (document.activeElement !== txt) txt.textContent = paraText(p);
    el.empty.hidden = true;
  }
  function renderAll() {
    el.paras.innerHTML = "";
    session.paragraphs.forEach(renderPara);
    el.empty.hidden = session.paragraphs.length > 0;
    updateSeekable();
    updateStats();
  }
  function updateStats() {
    const w = session.paragraphs.reduce((n, p) => n + countWords(paraText(p)), 0);
    el.words.textContent = `${w.toLocaleString("pt-BR")} ${w === 1 ? "palavra" : "palavras"}`;
    const c = session.paragraphs.length;
    el.count.textContent = `${c} ${c === 1 ? "parágrafo" : "parágrafos"}`;
  }
  function updateSeekable() {
    const can = !!session.audio;
    el.paras.querySelectorAll(".ts").forEach((b) => b.classList.toggle("seekable", can));
  }
  function seek(ms) {
    if (!session.audio || el.player.hidden) return;
    el.player.currentTime = ms / 1000;
    el.player.play().catch(() => {});
  }
  function scrollToBottom() {
    const r = el.interim.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 40 && !el.paras.contains(document.activeElement)) {
      window.scrollBy({ top: r.bottom - window.innerHeight + 120, behavior: "smooth" });
    }
  }

  // ---------- Recebendo texto ----------
  function showInterim(text) {
    if (text && utteranceStart === null) utteranceStart = elapsed();
    el.interim.textContent = text;
    if (text) { el.empty.hidden = true; scrollToBottom(); }
  }

  function addFinal(raw) {
    const txt = raw.trim();
    if (!txt) { utteranceStart = null; return; }
    const now = elapsed();
    const start = utteranceStart ?? Math.max(0, now - 1500);
    utteranceStart = null;

    let p = session.paragraphs[session.paragraphs.length - 1];

    // Evita repetições (bug conhecido do Chrome no Android)
    if (p && !p.edited && p.chunks.length) {
      const last = p.chunks[p.chunks.length - 1];
      const a = norm(txt), b = norm(last.raw);
      if (a === b || b.startsWith(a) || b.endsWith(a)) return;
      if (a.startsWith(b)) { last.raw = txt; last.t = now; renderPara(p); scheduleSave(); return; }
    }

    const gapMs = parseFloat(el.optGap.value) * 1000;
    const needNew = !p || forceNewPara || (start - lastFinalAt) > gapMs ||
      countWords(paraText(p)) > MAX_WORDS_PER_PARA;

    if (needNew) {
      p = { id: Math.random().toString(36).slice(2, 10), start, chunks: [] };
      session.paragraphs.push(p);
      forceNewPara = false;
    }
    if (p.edited != null) p.edited = (p.edited + " " + fmtChunk(txt)).trim();
    p.chunks.push({ raw: txt, s: start, t: now });
    lastFinalAt = now;

    renderPara(p);
    updateStats();
    scrollToBottom();
    scheduleSave(4000);
  }

  // ---------- Reconhecimento de voz ----------
  function startRecognition() {
    if (!SR) return;
    wantListening = true;
    const r = new SR();
    r.lang = el.lang.value;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) addFinal(res[0].transcript);
        else interim += res[0].transcript;
      }
      showInterim(interim.trim());
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantListening = false;
        toast("O navegador bloqueou a transcrição. Libere o microfone para este site.");
      } else if (e.error === "network") {
        toast("Sem conexão com o serviço de transcrição. Tentando de novo…");
      } else if (e.error === "language-not-supported") {
        wantListening = false;
        toast("Idioma não suportado neste navegador.");
      }
      // "no-speech" e "aborted" são normais: o reinício automático cuida disso
    };
    r.onend = () => {
      // Se havia texto parcial pendente, guarda para não perder
      const pending = el.interim.textContent.trim();
      if (pending) addFinal(pending);
      showInterim("");
      if (wantListening && recog === r) {
        setTimeout(() => {
          if (!(wantListening && recog === r)) return;
          try { r.start(); } catch { startRecognition(); }
        }, 150);
      }
    };
    recog = r;
    try { r.start(); } catch (err) { console.warn(err); }
  }
  function stopRecognition() {
    wantListening = false;
    if (recog) { try { recog.stop(); } catch {} }
  }

  // ---------- Áudio ----------
  function pickMime() {
    const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }
  const audioExt = (m) => (m.includes("mp4") ? "m4a" : m.includes("ogg") ? "ogg" : "webm");

  function setupMeter(s) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
    } catch (e) { analyser = null; }
  }

  const waveCtx = el.wave.getContext("2d");
  const history = new Array(120).fill(0);
  let lastPush = 0;
  function drawWave(ts) {
    const c = el.wave, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    waveCtx.clearRect(0, 0, w, h);

    if (analyser && status === "recording" && ts - lastPush > 50) {
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      history.push(Math.min(1, rms * 4.5)); history.shift();
      lastPush = ts;
    }
    const n = history.length, gap = w / n, bw = Math.max(1.5, gap * 0.55);
    const col = status === "recording" ? "#e5484d" : status === "paused" ? "#e2a336" : "#3a3a3a";
    waveCtx.fillStyle = col;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.03, history[i]);
      const bh = v * (h - 6);
      waveCtx.globalAlpha = 0.35 + 0.65 * (i / n);
      waveCtx.fillRect(i * gap, (h - bh) / 2, bw, bh);
    }
    waveCtx.globalAlpha = 1;
    el.timer.textContent = fmtTime(elapsed());
    rafId = requestAnimationFrame(drawWave);
  }
  rafId = requestAnimationFrame(drawWave);

  async function lockScreen() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && status === "recording") lockScreen();
  });

  // ---------- Controles ----------
  async function start() {
    if (status === "stopped") newSession(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      toast("Não consegui acessar o microfone. Verifique a permissão do navegador.");
      return;
    }
    syncMeta();
    setupMeter(stream);

    chunks = [];
    mime = pickMime();
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(1000);
    } catch (e) {
      recorder = null;
      toast("A gravação de áudio não é suportada aqui — só a transcrição será feita.");
    }

    startRecognition();
    status = "recording";
    startedAt = performance.now();
    elapsedBefore = 0;
    lastFinalAt = -Infinity;
    lockScreen();
    updateUI();
    save();
  }

  function pause() {
    if (status !== "recording") return;
    elapsedBefore = elapsed();
    status = "paused";
    stopRecognition();
    if (recorder && recorder.state === "recording") recorder.pause();
    updateUI();
    scheduleSave(200);
  }
  function resume() {
    if (status !== "paused") return;
    status = "recording";
    startedAt = performance.now();
    forceNewPara = true;
    if (recorder && recorder.state === "paused") recorder.resume();
    startRecognition();
    updateUI();
  }

  function stop() {
    if (status !== "recording" && status !== "paused") return;
    elapsedBefore = elapsed();
    session.duration = elapsedBefore;
    status = "stopped";
    stopRecognition();
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }

    const finish = async () => {
      if (chunks.length) {
        session.audio = new Blob(chunks, { type: mime || chunks[0].type || "audio/webm" });
        session.mime = session.audio.type;
        showPlayer();
      }
      stream && stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; analyser = null; }
      // aguarda resultados finais atrasados do reconhecimento
      setTimeout(async () => { await save(); updateSeekable(); toast("Sessão salva no Arquivo."); }, 900);
    };
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = finish;
      recorder.stop();
    } else finish();
    updateUI();
  }

  function showPlayer() {
    if (audioURL) URL.revokeObjectURL(audioURL);
    if (session.audio) {
      audioURL = URL.createObjectURL(session.audio);
      el.player.src = audioURL;
      el.player.hidden = false;
    } else {
      el.player.removeAttribute("src");
      el.player.hidden = true;
    }
  }

  function updateUI() {
    el.status.dataset.state = status;
    el.status.querySelector("b").textContent =
      { idle: "Pronto", recording: "Gravando", paused: "Pausado", stopped: "Encerrado" }[status];
    el.rec.dataset.state = status;
    el.rec.setAttribute("aria-label", status === "recording" ? "Pausar" : status === "paused" ? "Retomar" : "Gravar");
    el.rec.title = status === "recording" ? "Pausar (espaço)" : status === "paused" ? "Retomar (espaço)" : "Gravar (espaço)";
    el.stop.disabled = !(status === "recording" || status === "paused");
    el.para.disabled = status !== "recording";
    el.hint.innerHTML = {
      idle: "Toque no botão vermelho para começar. <kbd>Espaço</kbd> grava/pausa · <kbd>N</kbd> novo parágrafo",
      recording: "Ouvindo… Mantenha esta aba aberta e em primeiro plano.",
      paused: "Pausado. Toque para retomar ou no quadrado para encerrar.",
      stopped: "Gravação encerrada. Corrija o texto clicando nele e exporte. Gravar de novo inicia nova sessão.",
    }[status];
  }

  el.rec.addEventListener("click", () => {
    if (status === "recording") pause();
    else if (status === "paused") resume();
    else start();
  });
  el.stop.addEventListener("click", stop);
  el.para.addEventListener("click", () => { forceNewPara = true; toast("O próximo trecho começa um novo parágrafo."); });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(t.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); el.rec.click(); }
    else if (e.key === "n" || e.key === "N") { if (status === "recording") el.para.click(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (status === "recording" || status === "paused") { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------- Ajustes ----------
  const applyTs = () => el.doc.classList.toggle("hide-ts", !el.optTs.checked);
  el.optTs.addEventListener("change", () => { applyTs(); savePrefs(); });
  el.optPunct.addEventListener("change", () => { renderAll(); savePrefs(); });
  el.optGap.addEventListener("input", () => {
    el.gapVal.textContent = el.optGap.value.replace(".", ",") + " s"; savePrefs();
  });
  function savePrefs() {
    try {
      localStorage.setItem("palavra-prefs", JSON.stringify({
        punct: el.optPunct.checked, ts: el.optTs.checked, gap: el.optGap.value,
        lang: el.lang.value, kind: el.kind.value, speaker: el.speaker.value,
      }));
    } catch {}
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem("palavra-prefs") || "{}");
      if (p.punct != null) el.optPunct.checked = p.punct;
      if (p.ts != null) el.optTs.checked = p.ts;
      if (p.gap) { el.optGap.value = p.gap; el.gapVal.textContent = String(p.gap).replace(".", ",") + " s"; }
      if (p.lang) el.lang.value = p.lang;
      if (p.kind) el.kind.value = p.kind;
      if (p.speaker) el.speaker.value = p.speaker;
    } catch {}
  }
  [el.lang, el.kind, el.speaker].forEach((i) => i.addEventListener("change", savePrefs));

  // ---------- Sessões ----------
  function newSession(keepMeta = false) {
    if (status === "recording" || status === "paused") { toast("Encerre a gravação atual primeiro."); return; }
    const prev = { speaker: el.speaker.value, kind: el.kind.value, lang: el.lang.value };
    session = blankSession();
    status = "idle";
    elapsedBefore = 0;
    forceNewPara = false;
    history.fill(0);
    el.title.value = "";
    if (keepMeta) { el.speaker.value = prev.speaker; el.kind.value = prev.kind; el.lang.value = prev.lang; }
    el.interim.textContent = "";
    el.saveState.textContent = "";
    showPlayer();
    renderAll();
    syncMeta();
    updateUI();
  }
  el.btnNew.addEventListener("click", () => newSession(true));

  async function openSession(id) {
    if (status === "recording" || status === "paused") { toast("Encerre a gravação atual primeiro."); return; }
    const s = await DB.get(id);
    if (!s) return;
    session = s;
    status = "stopped";
    elapsedBefore = s.duration || 0;
    el.title.value = s.title || "";
    el.speaker.value = s.speaker || "";
    el.kind.value = s.kind || "Pregação";
    el.lang.value = s.lang || "pt-BR";
    showPlayer();
    renderAll();
    syncMeta();
    updateUI();
    el.saveState.textContent = "salvo";
    closeDrawer();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function renderList() {
    const all = (await DB.all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    el.list.innerHTML = all.length ? "" : `<li class="muted small">Nenhuma sessão gravada ainda.</li>`;
    for (const s of all) {
      const words = (s.paragraphs || []).reduce((n, p) => n + countWords(p.edited ?? p.chunks.map((c) => c.raw).join(" ")), 0);
      const li = document.createElement("li");
      li.className = "session";
      li.innerHTML = `<div>
          <h3>${esc(s.title || "Sem título")}</h3>
          <p>${esc(s.kind || "")}${s.speaker ? " · " + esc(s.speaker) : ""}</p>
          <p>${new Date(s.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${fmtTime(s.duration || 0)} · ${words} palavras${s.audio ? " · áudio" : ""}</p>
        </div>
        <button class="del" title="Apagar">Apagar</button>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".del")) return;
        openSession(s.id);
      });
      li.querySelector(".del").addEventListener("click", async () => {
        if (!confirm(`Apagar "${s.title || "Sem título"}"? Isso não pode ser desfeito.`)) return;
        await DB.del(s.id);
        if (s.id === session.id && status !== "recording" && status !== "paused") newSession(true);
        renderList();
      });
      el.list.appendChild(li);
    }
  }
  function openDrawer() { el.drawer.hidden = false; renderList(); }
  function closeDrawer() { el.drawer.hidden = true; }
  el.btnHistory.addEventListener("click", openDrawer);
  el.closeDrawer.addEventListener("click", closeDrawer);
  el.drawer.addEventListener("click", (e) => { if (e.target === el.drawer) closeDrawer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); el.exportMenu.hidden = true; } });

  // ---------- Exportação ----------
  function header() {
    const d = new Date(session.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    return { title: session.title || "Sem título", kind: session.kind, speaker: session.speaker, date: d, dur: fmtTime(session.duration || elapsed()) };
  }
  const withTs = () => el.optTs.checked;

  function toTXT() {
    const h = header();
    const lines = [h.title, [h.kind, h.speaker, h.date].filter(Boolean).join(" · "), `Duração: ${h.dur}`, ""];
    for (const p of session.paragraphs) lines.push((withTs() ? `[${fmtTime(p.start)}] ` : "") + paraText(p), "");
    return lines.join("\n");
  }
  function toMD() {
    const h = header();
    const out = [`# ${h.title}`, "", `*${[h.kind, h.speaker, h.date].filter(Boolean).join(" · ")} · ${h.dur}*`, ""];
    for (const p of session.paragraphs) out.push((withTs() ? `\`${fmtTime(p.start)}\` ` : "") + paraText(p), "");
    return out.join("\n");
  }
  function toSRT() {
    // Uma legenda por trecho reconhecido; trechos longos são divididos em ~12 palavras
    const cues = [];
    for (const p of session.paragraphs) {
      const src = p.edited != null ? [{ raw: p.edited, s: p.start, t: (p.chunks.at(-1)?.t ?? p.start + 4000) }] : p.chunks;
      for (const c of src) {
        const words = fmtChunk(c.raw).split(/\s+/);
        const parts = Math.max(1, Math.ceil(words.length / 12));
        const span = Math.max(1200, c.t - c.s);
        for (let i = 0; i < parts; i++) {
          cues.push({
            s: c.s + (span * i) / parts,
            e: c.s + (span * (i + 1)) / parts,
            text: words.slice(i * 12, (i + 1) * 12).join(" "),
          });
        }
      }
    }
    cues.sort((a, b) => a.s - b.s);
    for (let i = 0; i < cues.length; i++) {
      if (i > 0 && cues[i].s < cues[i - 1].e) cues[i].s = cues[i - 1].e;
      if (cues[i].e <= cues[i].s) cues[i].e = cues[i].s + 1000;
    }
    return cues.map((c, i) => `${i + 1}\n${fmtTime(c.s, true)} --> ${fmtTime(c.e, true)}\n${c.text}\n`).join("\n");
  }
  function toDOC() {
    const h = header();
    const body = session.paragraphs.map((p) =>
      `<p>${withTs() ? `<span style="color:#888;font-family:Consolas,monospace;font-size:9pt">[${fmtTime(p.start)}]</span> ` : ""}${esc(paraText(p))}</p>`
    ).join("\n");
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(h.title)}</title>
<style>
  @page { size: 21cm 29.7cm; margin: 3cm 2cm 2cm 3cm; }
  body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.5; }
  h1 { font-size: 16pt; text-align: center; margin-bottom: 4pt; }
  .meta { text-align: center; color: #555; font-style: italic; margin-bottom: 18pt; }
  p { text-align: justify; text-indent: 1.25cm; margin: 0 0 8pt; }
</style></head>
<body>
<h1>${esc(h.title)}</h1>
<p class="meta" style="text-indent:0">${esc([h.kind, h.speaker, h.date].filter(Boolean).join(" · "))} · ${h.dur}</p>
${body}
</body></html>`;
  }

  el.exportBtn.addEventListener("click", (e) => { e.stopPropagation(); el.exportMenu.hidden = !el.exportMenu.hidden; });
  document.addEventListener("click", () => (el.exportMenu.hidden = true));
  el.exportMenu.addEventListener("click", (e) => {
    const kind = e.target.dataset.exp;
    if (!kind) return;
    syncMeta();
    if (kind !== "audio" && !session.paragraphs.length) { toast("Ainda não há texto para exportar."); return; }
    const base = fileBase();
    if (kind === "txt") download(new Blob([toTXT()], { type: "text/plain;charset=utf-8" }), base + ".txt");
    if (kind === "md") download(new Blob([toMD()], { type: "text/markdown;charset=utf-8" }), base + ".md");
    if (kind === "srt") download(new Blob([toSRT()], { type: "application/x-subrip;charset=utf-8" }), base + ".srt");
    if (kind === "doc") download(new Blob(["﻿", toDOC()], { type: "application/msword" }), base + ".doc");
    if (kind === "audio") {
      if (!session.audio) { toast(status === "recording" || status === "paused" ? "Encerre a gravação para baixar o áudio." : "Esta sessão não tem áudio."); return; }
      download(session.audio, base + "." + audioExt(session.mime || ""));
    }
  });

  el.copy.addEventListener("click", async () => {
    const text = session.paragraphs.map(paraText).join("\n\n");
    if (!text) { toast("Ainda não há texto para copiar."); return; }
    try { await navigator.clipboard.writeText(text); toast("Transcrição copiada."); }
    catch { toast("Não foi possível copiar."); }
  });

  // ---------- Início ----------
  if (!SR) el.unsupported.hidden = false;
  if (!navigator.mediaDevices?.getUserMedia) {
    el.unsupported.hidden = false;
    el.unsupported.textContent = "Este navegador não permite acessar o microfone. Abra o app em HTTPS no Chrome ou Edge.";
    el.rec.disabled = true;
  }
  loadPrefs();
  applyTs();
  syncMeta();
  renderAll();
  updateUI();
})();
