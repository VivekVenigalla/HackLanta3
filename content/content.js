// ExpressiveLive content script: kinetic caption HUD + outbound voice drawer.
// Everything renders inside a closed Shadow DOM so host-site CSS can't leak in.
// ZERO DATA: caption nodes are removed after they fade; no history is kept.
(() => {
  if (window.__expressiveLiveLoaded) return;
  window.__expressiveLiveLoaded = true;

  const FADE_AFTER_MS = 3500;
  const MAX_LINES = 3;
  const MOODS = [
    { id: 'excited',  label: 'Excited',            hint: 'stab 0.30 · sim 0.85 · style 0.70' },
    { id: 'calm',     label: 'Calm / Neutral',     hint: 'stab 0.75 · sim 0.75 · style 0.00' },
    { id: 'whisper',  label: 'Whisper / Intimate', hint: 'stab 0.40 · sim 0.80 · style 0.50' },
    { id: 'dramatic', label: 'Dramatic / Urgent',  hint: 'stab 0.20 · sim 0.90 · style 0.80' },
  ];

  let ui = null; // built lazily so we never touch pages the user isn't using us on

  // ---------- prosody → kinetic style (Caption with Intention mapping) ----------
  // level 0..1 is loudness relative to the speaker's own baseline.
  //   Size + weight + width grow with volume: whispers are small, light,
  //   condensed and slanted; shouts are big, black, extended, and shake.
  //   Pitch lifts or drops the word off the baseline; a rising or falling
  //   contour inside the word animates it up or down (questions, trailing off).
  //   Speaker index picks the color.
  const WHISPER_BELOW = 0.3;
  const LOUD_ABOVE = 0.72;

  function styleWord(span, w) {
    const lvl = Math.max(0, Math.min(1, w.level ?? 0.5));
    const e = lvl * lvl * (3 - 2 * lvl); // smoothstep: push toward the extremes
    const st = span.style;
    st.setProperty('--fs', (0.72 + 0.78 * e).toFixed(3));         // 0.72× … 1.5×
    st.setProperty('--wght', Math.round(200 + 700 * e));           // 200 … 900
    st.setProperty('--wdth', Math.round(75 + 70 * e));             // 75 … 145
    st.setProperty('--slnt', lvl < WHISPER_BELOW ? -8 : 0);
    st.setProperty('--grad', lvl > LOUD_ABOVE ? 150 : 0);
    st.setProperty('--op', (0.6 + 0.4 * Math.min(1, lvl * 1.8)).toFixed(3));
    const lift = Math.max(-0.28, Math.min(0.28, -(w.pitch || 0) * 0.035));
    st.setProperty('--py', `${lift.toFixed(3)}em`);
    if (w.delay) st.animationDelay = `${w.delay}ms`;

    const slope = w.slope || 0;
    span.classList.toggle('whisper', lvl < WHISPER_BELOW);
    span.classList.toggle('loud', lvl > LOUD_ABOVE);
    span.classList.toggle('rise', slope > 1.5);
    span.classList.toggle('fall', slope < -1.5);
    span.dataset.speaker = String(w.speaker || 0);
  }

  // ---------- font + styles ----------
  async function registerFont() {
    if ([...document.fonts].some((f) => f.family === 'ExpressiveFlex')) return;
    try {
      const face = new FontFace(
        'ExpressiveFlex',
        `url(${chrome.runtime.getURL('styles/fonts/RobotoFlex-latin.woff2')}) format('woff2')`,
        { weight: '100 1000', style: 'normal', display: 'swap' },
      );
      document.fonts.add(face);
      await face.load();
    } catch {
      // Falls back to the system font stack in overlay.css.
    }
  }

  async function loadSheet() {
    // Constructable stylesheets aren't subject to the page's style-src CSP.
    const css = await (await fetch(chrome.runtime.getURL('content/overlay.css'))).text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet;
  }

  // ---------- UI construction ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = 'expressive-captions-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    const [sheet] = await Promise.all([loadSheet(), registerFont()]);
    shadow.adoptedStyleSheets = [sheet];

    // Caption HUD
    const hud = el('div', 'hud hidden');
    const status = el('div', 'status');
    const dot = el('span', 'dot');
    const statusText = el('span', 'status-text', 'Captions');
    const meter = el('span', 'meter');
    const meterFill = el('span', 'meter-fill');
    meter.append(meterFill);
    status.append(dot, statusText, meter);
    const lines = el('div', 'lines');
    hud.append(status, lines);

    // Floating pill
    const pill = el('button', 'pill');
    pill.type = 'button';
    pill.title = 'Expressive voice (Alt+V)';
    pill.append(el('span', 'pill-icon', '◉'), el('span', 'pill-label', 'Voice'));

    // Drawer
    const drawer = el('aside', 'drawer');
    drawer.setAttribute('aria-hidden', 'true');
    const head = el('div', 'drawer-head');
    const title = el('div', 'drawer-title');
    title.append(el('strong', null, 'Expressive Voice'), el('span', 'sub', 'Powered by ElevenLabs'));
    const close = el('button', 'icon-btn', '✕');
    close.type = 'button';
    close.title = 'Close (Esc)';
    head.append(title, close);

    const textarea = el('textarea', 'input');
    textarea.placeholder = 'Type what you want to say…';
    textarea.rows = 4;
    textarea.maxLength = 2500;

    const chipLabel = el('div', 'section-label', 'Mood');
    const chips = el('div', 'chips');
    let mood = 'excited';
    const chipEls = MOODS.map((m) => {
      const c = el('button', `chip chip-${m.id}`);
      c.type = 'button';
      c.dataset.mood = m.id;
      c.append(el('span', 'chip-label', m.label), el('span', 'chip-hint', m.hint));
      if (m.id === mood) c.classList.add('active');
      c.addEventListener('click', () => {
        mood = m.id;
        chipEls.forEach((x) => x.classList.toggle('active', x === c));
      });
      chips.append(c);
      return c;
    });

    const adv = el('details', 'adv');
    adv.append(el('summary', null, 'Voice'));
    const voiceInput = el('input', 'voice-input');
    voiceInput.placeholder = 'ElevenLabs voice ID';
    voiceInput.spellcheck = false;
    adv.append(voiceInput);
    chrome.runtime.sendMessage({ type: 'GET_DEFAULTS' }).then((r) => {
      if (r?.voiceId && !voiceInput.value) voiceInput.value = r.voiceId;
    }).catch(() => {});

    const speakBtn = el('button', 'speak', 'Speak');
    speakBtn.type = 'button';
    const toast = el('div', 'toast');
    const foot = el('div', 'drawer-foot', 'Ctrl/⌘ + Enter to speak · nothing is saved');

    drawer.append(head, textarea, chipLabel, chips, adv, speakBtn, toast, foot);
    shadow.append(hud, pill, drawer);
    (document.body || document.documentElement).append(host);

    ui = {
      host, shadow, hud, lines, statusText, meterFill, pill, drawer, textarea,
      speakBtn, toast, voiceInput, getMood: () => mood,
      current: null, // line element receiving partial words
      idleTimer: null,
      drawerOpen: false,
    };

    // --- events ---
    pill.addEventListener('click', toggleDrawer);
    close.addEventListener('click', () => setDrawer(false));
    speakBtn.addEventListener('click', doSpeak);
    // Keep host-site shortcuts (YouTube "k", Meet "Ctrl+D"…) from firing while typing.
    for (const t of ['keydown', 'keyup', 'keypress']) {
      drawer.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t !== 'keydown') return;
        if (e.key === 'Escape') setDrawer(false);
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSpeak(); }
      });
    }
    makeDraggable(hud);
    return ui;
  }

  // ---------- captions ----------
  function setWords(line, words) {
    const spans = line.children;
    for (let i = 0; i < words.length; i++) {
      let span = spans[i];
      if (!span) {
        span = el('span', 'word');
        line.append(span);
      }
      if (span.textContent !== words[i].text) span.textContent = words[i].text;
      // Existing words get refined in place (e.g. when exact word timings
      // arrive with the final transcript); CSS transitions smooth the change.
      styleWord(span, words[i]);
    }
    while (spans.length > words.length) spans[spans.length - 1].remove();
  }

  function onCaption({ words, isFinal, lineId, calibrated }) {
    const u = ui;
    if (!words?.length) return;
    if (calibrated != null) u.hud.classList.toggle('calibrating', !calibrated);
    u.hud.classList.remove('hidden', 'fading');
    if (!u.current) {
      u.current = el('div', 'line');
      u.lines.append(u.current);
    }
    setWords(u.current, words);
    if (isFinal) {
      u.current.classList.add('final');
      if (lineId != null) u.current.dataset.lineId = String(lineId);
      u.current = null;
    }
    // Drop oldest lines beyond the cap.
    while (u.lines.children.length > MAX_LINES) u.lines.firstElementChild.remove();
    resetIdle();
  }

  // ---------- sentiment: valence (words) × arousal (voice) → mood chip ----------
  const MOOD_UI = {
    excited:  ['🤩', 'Excited',  '#ffd166'],
    positive: ['🙂', 'Positive', '#7ae0a0'],
    warm:     ['☺️', 'Warm',     '#9be7c4'],
    angry:    ['😠', 'Angry',    '#ff5d73'],
    negative: ['🙁', 'Negative', '#ff9f6b'],
    sad:      ['😔', 'Sad',      '#7aa7ff'],
    emphatic: ['❗', 'Emphatic', '#b8a8ff'],
    quiet:    ['🤫', 'Quiet',    '#a7a7b8'],
  };

  function onSentiment({ lineId, mood }) {
    if (!ui) return;
    const line = ui.lines.querySelector(`.line[data-line-id="${lineId}"]`);
    const m = MOOD_UI[mood];
    if (!line || !m || line.querySelector('.mood')) return; // neutral: no chip
    line.dataset.mood = mood;
    line.style.setProperty('--mood', m[2]);
    const chip = el('span', 'mood');
    chip.append(el('span', 'mood-emoji', m[0]), el('span', 'mood-label', m[1]));
    line.prepend(chip);
  }

  function resetIdle() {
    clearTimeout(ui.idleTimer);
    ui.idleTimer = setTimeout(fadeOut, FADE_AFTER_MS);
  }

  function fadeOut() {
    const u = ui;
    u.lines.querySelectorAll('.line').forEach((line) => {
      line.classList.add('gone');
      line.addEventListener('animationend', (e) => { if (e.target === line) line.remove(); });
      setTimeout(() => line.remove(), 800); // safety if animations are disabled
    });
    u.current = null;
  }

  function onLevel(level) {
    if (!ui) return;
    ui.hud.style.setProperty('--level', level.toFixed(3));
    ui.meterFill.style.transform = `scaleX(${level.toFixed(3)})`;
  }

  // ---------- demo: shows the full expressive range without any audio ----------
  const DEMO = [
    [['psst…', .1, 2, 0], ['can', .15, 3, 0], ['you', .18, 4, 0], ['hear', .2, 5, 0], ['me?', .22, 6, 4]],
    [['Wait', .5, 0, 0, 1], ['what', .55, 2, 0, 1], ['happened', .6, 3, 2.5, 1], ['out', .6, 0, 0, 1], ['there?', .62, 5, 4, 1]],
    [['WE', .95, 6, 0], ['JUST', .97, 7, 0], ['WON', 1, 9, 0], ['THE', .9, 5, 0], ['GAME!', 1, 8, 2]],
    [['okay', .4, 0, 0, 1], ['okay…', .35, -2, -3, 1], ['calm', .3, -3, 0, 1], ['down', .25, -5, -4, 1], ['now.', .15, -6, -3, 1]],
  ];
  let demoTimers = [];
  async function runDemo() {
    await ensureUI();
    demoTimers.forEach(clearTimeout);
    demoTimers = [];
    let t = 0;
    for (const line of DEMO) {
      const words = line.map(([text, level, pitch, slope, speaker = 0], i) =>
        ({ text, level, pitch, slope, speaker, delay: i * 140 }));
      const lineId = `demo-${t}`;
      const mood = { 0: 'quiet', 2200: 'emphatic', 4400: 'excited', 6600: 'sad' }[t];
      demoTimers.push(setTimeout(() => onCaption({ words, isFinal: true, lineId }), t));
      demoTimers.push(setTimeout(() => onSentiment({ lineId, mood }), t + 700));
      words.forEach((w, i) => demoTimers.push(setTimeout(() => onLevel(w.level), t + i * 140)));
      t += 2200;
    }
    demoTimers.push(setTimeout(() => onLevel(0), t));
  }

  function onCaptureState({ capturing, mode, error }) {
    const u = ui;
    u.hud.classList.toggle('live', !!capturing);
    if (capturing) {
      u.statusText.textContent = mode === 'mic' ? 'Live · Microphone' : 'Live · Tab audio';
      u.hud.classList.remove('hidden');
    } else {
      u.statusText.textContent = error ? `Stopped · ${error}` : 'Stopped';
      onLevel(0);
      setTimeout(() => { if (!u.hud.classList.contains('live')) fadeOut(); }, 1500);
    }
  }

  // ---------- drawer + TTS ----------
  function setDrawer(open) {
    ui.drawerOpen = open;
    ui.drawer.classList.toggle('open', open);
    ui.drawer.setAttribute('aria-hidden', String(!open));
    ui.pill.classList.toggle('active', open);
    if (open) setTimeout(() => ui.textarea.focus(), 180);
  }

  let lastToggle = 0;
  async function toggleDrawer() {
    const now = Date.now();
    if (now - lastToggle < 250) return; // command + keydown may both fire
    lastToggle = now;
    await ensureUI();
    setDrawer(!ui.drawerOpen);
  }

  function showToast(msg, kind = 'info') {
    ui.toast.textContent = msg;
    ui.toast.className = `toast show ${kind}`;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, 4000);
  }

  async function doSpeak() {
    const text = ui.textarea.value.trim();
    if (!text || ui.speakBtn.disabled) return;
    ui.speakBtn.disabled = true;
    ui.speakBtn.classList.add('loading');
    ui.speakBtn.textContent = 'Synthesizing…';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'SPEAK',
        text,
        mood: ui.getMood(),
        voiceId: ui.voiceInput.value.trim() || undefined,
      });
      if (!res?.ok) throw new Error(res?.error || 'Speech failed');
      ui.textarea.value = ''; // ephemeral: text is gone once spoken
      ui.speakBtn.textContent = 'Speaking…';
    } catch (err) {
      showToast(err.message || String(err), 'error');
      resetSpeakBtn();
    }
  }

  function resetSpeakBtn() {
    ui.speakBtn.disabled = false;
    ui.speakBtn.classList.remove('loading');
    ui.speakBtn.textContent = 'Speak';
  }

  // ---------- drag ----------
  function makeDraggable(node) {
    let start = null;
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = node.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      node.setPointerCapture(e.pointerId);
      node.classList.add('dragging');
    });
    node.addEventListener('pointermove', (e) => {
      if (!start) return;
      const left = Math.max(0, Math.min(window.innerWidth - node.offsetWidth, start.left + e.clientX - start.x));
      const top = Math.max(0, Math.min(window.innerHeight - node.offsetHeight, start.top + e.clientY - start.y));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.bottom = 'auto';
      node.style.transform = 'none';
    });
    const end = () => { start = null; node.classList.remove('dragging'); };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('dblclick', () => { // re-anchor bottom-center
      for (const p of ['left', 'top', 'bottom', 'transform']) node.style.removeProperty(p);
    });
  }

  // ---------- wiring ----------
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyV') {
      e.preventDefault();
      toggleDrawer();
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING':
        sendResponse({ ok: true });
        return false;
      case 'LEVEL':
        onLevel(msg.level ?? 0);
        return false;
      case 'CAPTION':
        ensureUI().then(() => onCaption(msg));
        return false;
      case 'CAPTURE_STATE':
        ensureUI().then(() => onCaptureState(msg));
        return false;
      case 'SENTIMENT':
        onSentiment(msg);
        return false;
      case 'RUN_DEMO':
        runDemo();
        return false;
      case 'TOGGLE_DRAWER':
        lastToggle = 0;
        toggleDrawer();
        return false;
      case 'SET_CAPTION_SIZE':
        ensureUI().then(() => ui.hud.style.setProperty('--size', `${msg.size}px`));
        return false;
      case 'SPEAK_STATE':
        if (ui && msg.state === 'ended') resetSpeakBtn();
        return false;
      default:
        return false;
    }
  });
})();
