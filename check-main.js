
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const todayKey = (d = new Date()) => d.toDateString();

  // ---- DB ----
  const db = new Dexie('nuvola-diary');
  db.version(1).stores({ entries: '++id, timestamp' });
  db.version(2).stores({ entries: '++id, timestamp', checkins: '++id, timestamp' });
  // entries: id, timestamp, title, diaryText, sentimentScore, coachFeedbackText
  // checkins: id, timestamp, face (0..4)

  // ---- Coach models ----
  const COACH_MODELS = {
    '0.5b': { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Small', size: '~450 MB', desc: 'Fast, good for most phones.' },
    '1.5b': { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Better quality', size: '~1.3 GB', desc: 'More thoughtful, wants a newer device.' },
  };
  const FACES = ['😞','🙁','😐','🙂','😄'];
  const FACE_LABELS = ['Rough','Low','Okay','Good','Great'];
  const PROMPTS = [
    "What's one small thing that went right today?",
    "What's taking up the most space in your head right now?",
    "Who or what made you smile recently?",
    "What are you avoiding writing about?",
    "Describe today in exactly three sentences.",
    "What do you need more of this week?",
    "What's something you're proud of, even a little?",
    "What would make tomorrow feel easier?",
    "What's a worry you can set down, just for now?",
    "What surprised you today?",
    "Write a note to yourself from a week from now.",
    "What's weighing on you that you haven't said out loud?",
    "What went differently than you expected?",
    "What's something ordinary that felt good today?",
    "If today had a title, what would it be?",
  ];
  const dayOfYear = (d = new Date()) => Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);

  // ---- State ----
  let activeId = null, streaming = false, timer = null, seq = 0, focusMode = false;
  let coachEnabled = localStorage.getItem('nuvola.coachEnabled') === 'true';
  let coachSize = localStorage.getItem('nuvola.coachSize') || '0.5b';
  let ready = false, downloading = false;
  const prog = { sentiment: 0, coach: 0, text: '' };
  const pending = new Map();
  let deferredInstall = null;
  let pendingDelete = null, deleteTimer = null;
  let currentPrompt = PROMPTS[dayOfYear() % PROMPTS.length];

  // ---- Compatibility check ----
  function detectInAppBrowser() {
    const ua = navigator.userAgent || '';
    if (/Instagram/i.test(ua)) return 'Instagram';
    if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
    return null;
  }
  const inAppBrowser = detectInAppBrowser();
  const hasWebGPU = 'gpu' in navigator;
  const coachSupported = hasWebGPU && !inAppBrowser;

  if (inAppBrowser) {
    $('#iab-text').textContent = `You're viewing this inside the ${inAppBrowser} app, which blocks the private AI coach. Journaling and mood check-ins still work here. Tap ⋯ (or the browser icon) in the top corner → "Open in Chrome" or "Open in Safari" to unlock the coach.`;
    $('#iab-banner').classList.remove('hidden');
  }

  // ---- Theme ----
  function applyTheme(mode) {
    const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    $$('.theme-opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === mode)));
    $$('.theme-opt').forEach((b) => b.className = `theme-opt flex-1 tap rounded-lg border px-3 py-2 text-sm ${b.dataset.theme === mode ? 'border-sky text-sky' : 'border-dusk'}`);
  }
  let themeMode = localStorage.getItem('nuvola.theme') || 'system';
  applyTheme(themeMode);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (themeMode === 'system') applyTheme('system'); });
  $$('.theme-opt').forEach((b) => b.onclick = () => { themeMode = b.dataset.theme; localStorage.setItem('nuvola.theme', themeMode); applyTheme(themeMode); });

  // ---- Toast ----
  function showToast(message, opts = {}) {
    const wrap = $('#toast-wrap');
    const el = document.createElement('div');
    el.className = 'anim-rise pointer-events-auto max-w-sm w-full bg-ink text-paper rounded-xl shadow-lg px-4 py-3 flex items-center justify-between gap-3 text-sm';
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (opts.actionLabel) {
      const btn = document.createElement('button');
      btn.className = 'font-medium text-sky shrink-0 tap px-1'; btn.textContent = opts.actionLabel;
      btn.onclick = () => { opts.onAction?.(); el.remove(); };
      el.appendChild(btn);
    }
    wrap.appendChild(el);
    setTimeout(() => el.remove(), opts.duration ?? 6000);
  }

  // ---- Onboarding ----
  const OB = [
    { title: 'A private place to write', body: "Nuvola is a journal with real-time mood insights and a gentle AI coach — entirely on this device.", icon: '✍️' },
    { title: "Why it's actually private", body: "There's no server. Your words never leave your phone or computer — not for saving, not for the mood chart, not for the coach.", icon: '🔒' },
    { title: 'Where to start', body: "Just write. Everything else — check-ins, the coach, dark mode — is there when you want it.", icon: '☁️' },
  ];
  let obIdx = 0;
  function renderOb() {
    $('#ob-slides').innerHTML = `<div class="text-5xl anim-pop">${OB[obIdx].icon}</div><h1 class="font-serif text-2xl">${OB[obIdx].title}</h1><p class="text-mist leading-6">${OB[obIdx].body}</p>`;
    $('#ob-dots').innerHTML = OB.map((_, i) => `<span class="w-1.5 h-1.5 rounded-full ${i === obIdx ? 'bg-sky' : 'bg-dusk'}"></span>`).join('');
    $('#ob-next').textContent = obIdx === OB.length - 1 ? 'Start writing' : 'Next';
    $('#ob-skip').classList.toggle('invisible', obIdx === OB.length - 1);
  }
  function closeOnboarding() {
    localStorage.setItem('nuvola.onboarded', 'true');
    $('#onboarding').classList.add('hidden');
    if (!inAppBrowser) $('#text')?.focus();
  }
  $('#ob-next').onclick = () => { if (obIdx === OB.length - 1) closeOnboarding(); else { obIdx++; renderOb(); } };
  $('#ob-skip').onclick = closeOnboarding;
  if (!localStorage.getItem('nuvola.onboarded')) { $('#onboarding').classList.remove('hidden'); renderOb(); }

  // ---- Worker bridge ----
  const worker = new Worker(URL.createObjectURL(new Blob([$('#worker-src').textContent], { type: 'text/javascript' })), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (data.type === 'progress') { prog[data.stage] = data.progress; prog.text = data.text; renderCoachCard(); }
    else if (data.type === 'ready') { ready = true; downloading = false; renderCoachCard(); renderYouCoach(); }
    else if (data.type === 'token') p?.onToken?.(data.delta);
    else if (data.type === 'sentiment' || data.type === 'done') { p?.resolve(data.result ?? data.text); pending.delete(data.id); }
    else if (data.type === 'error') {
      downloading = false;
      $('#error') && ($('#error').textContent = friendlyError(data.message));
      p?.reject(new Error(data.message)); pending.delete(data.id);
      renderCoachCard(data.message);
    }
  };
  worker.onerror = (e) => { downloading = false; renderCoachCard("Couldn't start the on-device model. Check your connection and try again."); };
  const request = (msg, onToken) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, onToken }); worker.postMessage({ ...msg, id }); });
  function friendlyError(msg) {
    if (/webgpu/i.test(msg)) return "This browser can't run the coach yet. Your journal and mood check-ins still work fine.";
    return "Something went sideways loading the model. Mind trying again?";
  }

  function startDownload(size) {
    coachSize = size; coachEnabled = true; downloading = true; ready = false;
    localStorage.setItem('nuvola.coachEnabled', 'true'); localStorage.setItem('nuvola.coachSize', size);
    prog.sentiment = 0; prog.coach = 0; prog.text = 'Starting…';
    worker.postMessage({ type: 'warmup', modelId: COACH_MODELS[size].id });
    renderCoachCard(); renderYouCoach();
  }

  // ---- Coach card (Write tab) ----
  function renderCoachCard(err) {
    const wrap = $('#coach-wrap');
    if (!coachSupported) {
      wrap.innerHTML = `
        <div class="flex items-center justify-between"><h2 class="font-medium">Local coach</h2><span class="text-xs text-mist">Not available</span></div>
        <p class="mt-2 text-sm text-mist leading-6">${inAppBrowser ? `Open this page in Chrome or Safari to use the coach — see the note above.` : `Your browser doesn't support the on-device model yet. Try a recent version of Chrome or Edge. Journaling and mood tracking work great without it.`}</p>`;
      return;
    }
    if (!coachEnabled) {
      wrap.innerHTML = `
        <div class="flex items-center justify-between"><h2 class="font-medium">Local coach</h2></div>
        <p class="mt-2 text-sm text-mist leading-6">Optional. A short, kind reflection on what you write — generated on this device. Downloads in the background while you keep writing.</p>
        <div class="mt-3 grid sm:grid-cols-2 gap-2">
          ${Object.entries(COACH_MODELS).map(([k, m]) => `
            <button data-size="${k}" class="size-opt text-left rounded-xl border border-dusk p-3 hover:border-sky">
              <span class="block font-medium text-sm">${m.label}${k === '0.5b' ? ' <span class=\"text-xs font-normal text-mist\">(default)</span>' : ''}</span>
              <span class="block text-xs text-mist mt-0.5">${m.desc}</span>
              <span class="block text-xs text-sky mt-1">One-time ${m.size} download. Works offline after.</span>
            </button>`).join('')}
        </div>`;
      $$('.size-opt', wrap).forEach((b) => b.onclick = () => startDownload(b.dataset.size));
      return;
    }
    if (downloading || !ready) {
      const pct = Math.round(((prog.sentiment + prog.coach) / 2) * 100);
      wrap.innerHTML = `
        <div class="flex items-center justify-between"><h2 class="font-medium">Local coach</h2><span class="text-xs text-mist">Downloading</span></div>
        <p class="mt-2 text-sm text-mist">Keep writing — this won't interrupt you. One-time ${COACH_MODELS[coachSize].size} download, then it works offline.</p>
        <div class="mt-3 h-1.5 rounded-full bg-dusk overflow-hidden"><div class="h-full bg-sky transition-[width]" style="width:${pct || 2}%"></div></div>
        <p class="mt-1 text-xs text-mist truncate">${pct}% · ${esc(prog.text || 'Starting…')}</p>
        ${err ? `<p class="mt-2 text-sm text-danger">${esc(friendlyError(err))}</p>` : ''}`;
      return;
    }
    // ready
    wrap.innerHTML = `
      <div class="flex items-center justify-between">
        <h2 class="font-medium">Local coach</h2>
        <button id="coach-btn" class="text-sm rounded-full bg-sky text-white px-3 py-1.5 tap disabled:opacity-40">Get feedback</button>
      </div>
      <p id="coach" class="mt-3 text-[15px] leading-7 whitespace-pre-wrap min-h-[3rem]"></p>
      <p id="error" class="mt-2 text-sm text-danger"></p>`;
    const savedEntry = activeId ? entryCache.get(activeId) : null;
    $('#coach').textContent = savedEntry?.coachFeedbackText || '';
    if (!$('#coach').textContent) $('#coach').innerHTML = `<span class="text-mist">Write an entry, then ask for a short, kind reflection.</span>`;
    const coachBtn = $('#coach-btn');
    coachBtn.onclick = async () => {
      if (streaming) return worker.postMessage({ type: 'interrupt' });
      const text = $('#text').value; if (!text.trim()) return;
      await save();
      streaming = true; coachBtn.textContent = 'Stop'; $('#coach').textContent = ''; $('#error').textContent = '';
      const sentiment = activeId ? (await db.entries.get(activeId))?.sentimentScore : null;
      let acc = '';
      try {
        const final = await request({ type: 'coach', text, sentiment, modelId: COACH_MODELS[coachSize].id }, (d) => { acc += d; $('#coach').textContent = acc; });
        if (activeId) await db.entries.update(activeId, { coachFeedbackText: final });
      } catch {}
      streaming = false; coachBtn.textContent = 'Get feedback';
    };
  }
  const entryCache = new Map();

  // ---- You tab coach settings ----
  function renderYouCoach() {
    const status = $('#you-coach-status'), actions = $('#you-coach-actions');
    if (!coachSupported) {
      status.textContent = inAppBrowser ? `Unavailable in the ${inAppBrowser} app browser.` : "Not supported in this browser.";
      actions.innerHTML = ''; return;
    }
    if (!coachEnabled) { status.textContent = 'Off. Turn it on from the Write tab whenever you like.'; actions.innerHTML = ''; return; }
    if (downloading || !ready) { status.textContent = `Downloading the ${COACH_MODELS[coachSize].label} model…`; actions.innerHTML = ''; return; }
    status.textContent = `On — using the ${COACH_MODELS[coachSize].label} model (${COACH_MODELS[coachSize].size}).`;
    const other = coachSize === '0.5b' ? '1.5b' : '0.5b';
    actions.innerHTML = `
      <button id="switch-size" class="text-sm rounded-full border border-dusk px-3 py-1.5 tap hover:bg-dusk/60">Switch to ${COACH_MODELS[other].label}</button>
      <button id="turn-off" class="text-sm rounded-full border border-dusk px-3 py-1.5 tap hover:bg-dusk/60">Turn off coach</button>`;
    $('#switch-size').onclick = () => startDownload(other);
    $('#turn-off').onclick = () => { coachEnabled = false; localStorage.setItem('nuvola.coachEnabled', 'false'); renderYouCoach(); renderCoachCard(); showToast('Coach turned off. Your entries and mood chart are untouched.'); };
  }

  // ---- Markdown (escaped first) ----
  const md = (src) => esc(src)
    .replace(/^### (.*)$/gm,'<h3 class="font-serif text-lg mt-3">$1</h3>').replace(/^## (.*)$/gm,'<h2 class="font-serif text-xl mt-4">$1</h2>').replace(/^# (.*)$/gm,'<h1 class="font-serif text-2xl mt-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/^- (.*)$/gm,'<li class="ml-5 list-disc">$1</li>').replace(/\n/g,'<br/>');

  // ---- Entries ----
  async function refreshList() {
    const rows = await db.entries.orderBy('timestamp').reverse().toArray();
    rows.forEach((e) => entryCache.set(e.id, e));
    const html = rows.length
      ? rows.map((e) => `<li><button data-id="${e.id}" class="w-full text-left rounded-lg px-3 py-2.5 truncate ${e.id === activeId ? 'bg-dusk' : 'hover:bg-dusk/60'}"><span class="block truncate">${esc(e.title)}</span><span class="text-xs text-mist">${new Date(e.timestamp).toLocaleDateString()}</span></button></li>`).join('')
      : `<li class="text-mist px-3 py-2">Your entries will show up here once you write one.</li>`;
    ['#list-desktop', '#list-mobile'].forEach((sel) => {
      const el = $(sel); if (!el) return;
      el.innerHTML = html;
      $$('button', el).forEach((b) => (b.onclick = () => { select(+b.dataset.id); $('#history-sheet').classList.add('hidden'); }));
    });
  }
  async function select(id) {
    if (timer) { clearTimeout(timer); timer = null; await save(); }
    activeId = id;
    const e = id ? await db.entries.get(id) : null;
    $('#title').value = e?.title ?? ''; $('#text').value = e?.diaryText ?? ''; $('#saved').textContent = id ? 'Saved entry' : 'A fresh page';
    $('#entry-date').textContent = e ? new Date(e.timestamp).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    updateWordCount();
    $('#delete').classList.toggle('hidden', !id);
    renderPromptVisibility();
    showTab('write'); refreshList(); renderCoachCard();
  }
  async function save() {
    const title = $('#title').value, text = $('#text').value;
    if (!title.trim() && !text.trim()) { $('#saved').textContent = 'A blank page, ready when you are'; return; }
    const base = { title: title.trim() || 'Untitled', diaryText: text };
    try {
      $('#saved').textContent = 'Saving…';
      if (activeId) await db.entries.update(activeId, base);
      else {
        activeId = await db.entries.add({ ...base, timestamp: Date.now(), sentimentScore: null, coachFeedbackText: '' });
        $('#delete').classList.remove('hidden');
      }
      $('#saved').textContent = 'Saved just now';
      $('#entry-date').textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
      refreshList(); renderStreak();
      const currentId = activeId;
      if (coachEnabled && ready && text.trim().length > 20) {
        try {
          const sentiment = await request({ type: 'analyze', text });
          if (currentId === activeId) await db.entries.update(currentId, { sentimentScore: sentiment });
        } catch {}
      }
    } catch (err) {
      $('#saved').textContent = 'Couldn’t save — your text is still here';
      showToast('Your entry could not be saved. Please check available storage and try again.');
    }
  }
  function updateWordCount() {
    const value = $('#text').value.trim();
    const words = value ? value.split(/\s+/).length : 0;
    $('#word-count').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${words ? Math.max(1,Math.ceil(words/220)) : 0} min`;
  }
  const queueSave = () => {
    $('#saved').textContent = 'Unsaved changes';
    clearTimeout(timer);
    timer = setTimeout(save, 850);
    updateWordCount();
    renderPromptVisibility();
    if (!$('#preview').classList.contains('hidden')) {
      $('#preview').innerHTML = md($('#text').value) || '<span class="text-mist">Nothing to preview yet.</span>';
    }
  };
  $('#title').oninput = queueSave; $('#text').oninput = queueSave;
  $('#focus-toggle').onclick = () => {
    focusMode = !focusMode;
    document.body.classList.toggle('focus-writing', focusMode);
    $('#focus-toggle').textContent = focusMode ? 'Exit focus' : 'Focus';
    $('#focus-toggle').setAttribute('aria-pressed', String(focusMode));
    if (focusMode) $('#text').focus();
  };
  document.addEventListener('keydown', (e) => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); clearTimeout(timer); save(); }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); clearTimeout(timer); save().finally(newEntry); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#focus-toggle').click(); }
    if (e.key === 'Escape' && focusMode) { focusMode = false; document.body.classList.remove('focus-writing'); $('#focus-toggle').textContent = 'Focus'; $('#focus-toggle').setAttribute('aria-pressed','false'); }
  }, true);

  function newEntry() { if (activeId === null && !$('#text').value.trim() && !$('#title').value.trim()) { $('#text').focus(); return; } select(null); }
  $('#new-desktop').onclick = newEntry; $('#fab-new').onclick = newEntry;

  async function requestDelete() {
    if (!activeId) return;
    const e = await db.entries.get(activeId);
    if (!window.confirm(`Delete “${e?.title || 'Untitled'}”? This entry will be removed from this device.`)) return;
    await db.entries.delete(activeId);
    pendingDelete = e;
    select(null);
    showToast(`Deleted "${e.title || 'Untitled'}"`, {
      actionLabel: 'Undo',
      onAction: async () => { if (!pendingDelete) return; const { id, ...rest } = pendingDelete; const newId = await db.entries.add(rest); pendingDelete = null; select(newId); },
    });
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => { pendingDelete = null; }, 6000);
  }
  $('#delete').onclick = requestDelete;

  $('#preview-toggle').onclick = () => {
    const showing = $('#preview').classList.toggle('hidden') === false;
    $('#text').classList.toggle('hidden', showing);
    $('#preview').innerHTML = md($('#text').value) || '<span class="text-mist">Nothing to preview yet.</span>';
    $('#preview-toggle').textContent = showing ? 'Edit' : 'Preview markdown';
  };

  // ---- Quick check-in ----
  function renderFaces() {
    $('#faces').innerHTML = FACES.map((f, i) => `<button class="face-btn tap rounded-full text-2xl hover:scale-110 transition-transform" data-i="${i}" aria-pressed="false" aria-label="${FACE_LABELS[i]}" title="${FACE_LABELS[i]}">${f}</button>`).join('');
    $$('.face-btn').forEach((b) => b.onclick = async () => {
      const face = +b.dataset.i;
      $$('.face-btn').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.i === face)));
      const existing = await db.checkins.toArray();
      const today = existing.find((c) => todayKey(new Date(c.timestamp)) === todayKey());
      if (today) await db.checkins.update(today.id, { face, timestamp: Date.now() });
      else await db.checkins.add({ face, timestamp: Date.now() });
      renderStreak(); renderCheckin(); showToast(`Mood check-in saved: ${FACE_LABELS[face].toLowerCase()}.`);
    });
  }
  async function renderCheckin() {
    const rows = await db.checkins.where('timestamp').above(Date.now() - 86400000 * 2).reverse().toArray();
    const todays = rows.find((c) => todayKey(new Date(c.timestamp)) === todayKey());
    $('#checkin-prompt').classList.toggle('hidden', !!todays);
    $('#checkin-done').classList.toggle('hidden', !todays);
    if (todays) { $('#checkin-done-text').textContent = `You checked in today: ${FACES[todays.face]} ${FACE_LABELS[todays.face]}`; $$('.face-btn').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === todays.face))); }
  }
  $('#checkin-change').onclick = () => { $('#checkin-prompt').classList.remove('hidden'); $('#checkin-done').classList.add('hidden'); };

  // ---- Daily prompt ----
  function renderPromptVisibility() {
    $('#prompt-card').classList.toggle('hidden', $('#text').value.trim().length > 0);
    $('#prompt-text').textContent = currentPrompt;
  }
  $('#prompt-shuffle').onclick = () => {
    let next; do { next = PROMPTS[Math.floor(Math.random() * PROMPTS.length)]; } while (next === currentPrompt && PROMPTS.length > 1);
    currentPrompt = next; $('#prompt-text').textContent = currentPrompt;
  };

  // ---- Streak ----
  async function computeStreak() {
    const days = new Set();
    (await db.entries.toArray()).forEach((e) => days.add(todayKey(new Date(e.timestamp))));
    (await db.checkins.toArray()).forEach((c) => days.add(todayKey(new Date(c.timestamp))));
    let cursor = new Date();
    if (!days.has(todayKey(cursor))) { cursor.setDate(cursor.getDate() - 1); if (!days.has(todayKey(cursor))) return 0; }
    let streak = 0;
    while (days.has(todayKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return streak;
  }
  async function renderStreak() {
    const n = await computeStreak();
    const text = n > 0 ? `🔥 ${n} day${n === 1 ? '' : 's'}` : '';
    $('#streak-mobile').textContent = text;
    $('#streak-desktop').textContent = n > 0 ? `🔥 ${n} day streak` : 'Write today to start a streak';
  }

  // ---- Mood tab ----
  async function renderMood() {
    const entries = (await db.entries.orderBy('timestamp').toArray()).filter((e) => e.sentimentScore);
    const checkins = await db.checkins.orderBy('timestamp').toArray();
    const faceVal = [0, 0.25, 0.5, 0.75, 1];
    const points = [
      ...entries.map((e) => ({ t: e.timestamp, v: e.sentimentScore.valence, kind: 'entry' })),
      ...checkins.map((c) => ({ t: c.timestamp, v: faceVal[c.face], kind: 'checkin' })),
    ].sort((a, b) => a.t - b.t);
    const chart = $('#chart'), dl = $('#emotions');
    if (points.length < 2) {
      chart.innerHTML = `<p class="text-mist rounded-2xl bg-card border border-dusk p-5">Check in a couple more times, or turn on the coach to score entries, and your trend will show up here.</p>`;
      dl.innerHTML = ''; return;
    }
    const W = 640, H = 240, P = 32, n = points.length;
    const pts = points.map((pt, i) => [P + (i * (W - 2 * P)) / (n - 1), H - P - pt.v * (H - 2 * P), pt]);
    const line = pts.map((p) => p.slice(0, 2).join(',')).join(' ');
    const grid = [0, 50, 100].map((v) => { const y = H - P - (v / 100) * (H - 2 * P); return `<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}" stroke="var(--dusk)"/><text x="4" y="${y + 4}" font-size="11" fill="var(--mist)">${v}</text>`; }).join('');
    const dots = pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${p[2].kind === 'entry' ? 'var(--sky)' : 'var(--paper)'}" stroke="var(--sky)" stroke-width="2"><title>${new Date(p[2].t).toLocaleDateString()} · ${p[2].kind === 'entry' ? 'entry' : 'check-in'}: ${Math.round(p[2].v * 100)}</title></circle>`).join('');
    chart.innerHTML = `<div class="rounded-2xl bg-card border border-dusk p-4 overflow-x-auto"><svg viewBox="0 0 ${W} ${H}" class="w-full min-w-[420px]" role="img" aria-label="Mood over time">${grid}<polygon points="${P},${H - P} ${line} ${W - P},${H - P}" fill="var(--sky)" fill-opacity=".15"/><polyline points="${line}" fill="none" stroke="var(--sky)" stroke-width="2"/>${dots}<text x="${P}" y="${H - 8}" font-size="11" fill="var(--mist)">${new Date(points[0].t).toLocaleDateString()}</text><text x="${W - P}" y="${H - 8}" font-size="11" text-anchor="end" fill="var(--mist)">${new Date(points[n - 1].t).toLocaleDateString()}</text></svg></div>
    <p class="text-xs text-mist mt-2">Blue filled dots are AI-estimated entry tone; outlined dots are your own mood check-ins. AI estimates can miss context.</p>`;
    if (entries.length) {
      dl.innerHTML = ['joy','sadness','anger','fear','calm'].map((k) => `<div class="rounded-xl bg-dusk/60 py-3"><dt class="text-mist capitalize">${k}</dt><dd class="text-lg font-serif">${Math.round((entries.reduce((a, e) => a + e.sentimentScore.emotions[k], 0) / entries.length) * 100)}%</dd></div>`).join('');
    } else {
      dl.innerHTML = `<div class="col-span-5 text-xs text-mist">Turn on the coach to see an emotion breakdown alongside check-ins.</div>`;
    }
    renderShareCard(points);
  }

  // ---- Weekly mood share card ----
  async function renderShareCard(allPoints) {
    const weekAgo = Date.now() - 7 * 86400000;
    const points = (allPoints ?? []).filter((p) => p.t >= weekAgo);
    const cv = $('#share-preview'), ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const dark = document.documentElement.classList.contains('dark');
    const bg = dark ? ['#1B1D22', '#2A3550'] : ['#F7F6F2', '#DCE6F5'];
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, bg[1]); g.addColorStop(1, bg[0]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // soft cloud shapes
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.6)';
    [[W*0.2,H*0.12,28],[W*0.6,H*0.08,20],[W*0.8,H*0.18,16]].forEach(([x,y,r]) => { ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.arc(x+r*0.9,y+4,r*0.7,0,7); ctx.arc(x-r*0.9,y+4,r*0.6,0,7); ctx.fill(); });
    ctx.fillStyle = dark ? '#EDEDEF' : '#23262B';
    ctx.font = '600 20px Georgia, serif'; ctx.fillText('Nuvola', 28, 56);
    ctx.font = '400 13px system-ui, sans-serif'; ctx.fillStyle = dark ? '#8D93A3' : '#8A93A6';
    ctx.fillText("This week's mood", 28, 78);
    if (points.length < 2) {
      ctx.fillStyle = dark ? '#8D93A3' : '#8A93A6';
      ctx.font = '400 14px system-ui, sans-serif';
      wrapText(ctx, 'Not enough check-ins this week yet — come back after a few more days.', 28, H*0.45, W-56, 20);
    } else {
      const pad = 40, top = H*0.32, bottom = H*0.62;
      const xs = points.map((_, i) => pad + i * (W - 2*pad) / (points.length - 1));
      const ys = points.map((p) => bottom - p.v * (bottom - top));
      ctx.beginPath(); ctx.moveTo(xs[0], ys[0]);
      for (let i=1;i<xs.length;i++) ctx.lineTo(xs[i], ys[i]);
      ctx.strokeStyle = '#5B7DB1'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
      xs.forEach((x, i) => { ctx.beginPath(); ctx.arc(x, ys[i], 6, 0, 7); ctx.fillStyle = '#5B7DB1'; ctx.fill(); });
      const avg = Math.round((points.reduce((a,p)=>a+p.v,0)/points.length)*100);
      ctx.fillStyle = dark ? '#EDEDEF' : '#23262B';
      ctx.font = '600 44px Georgia, serif'; ctx.fillText(String(avg), 28, H*0.78);
      ctx.font = '400 13px system-ui, sans-serif'; ctx.fillStyle = dark ? '#8D93A3' : '#8A93A6';
      ctx.fillText('average, out of 100', 28, H*0.78 + 20);
    }
    ctx.font = '400 11px system-ui, sans-serif'; ctx.fillStyle = dark ? '#8D93A3' : '#8A93A6';
    ctx.fillText('Made privately, on-device · nuvoladiary.app', 28, H - 24);
  }
  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' '); let line = '';
    for (const w of words) {
      const test = line + w + ' ';
      if (ctx.measureText(test).width > maxWidth && line) { ctx.fillText(line, x, y); line = w + ' '; y += lineHeight; }
      else line = test;
    }
    ctx.fillText(line, x, y);
  }
  function fullShareCanvas() {
    const src = $('#share-preview');
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    return cv;
  }
  $('#share-download').onclick = () => {
    const cv = fullShareCanvas();
    cv.toBlob((blob) => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `nuvola-mood-week-${new Date().toISOString().slice(0,10)}.png` });
      a.click(); URL.revokeObjectURL(a.href);
    });
  };
  if (navigator.canShare && navigator.share) {
    $('#share-native').classList.remove('hidden');
    $('#share-native').onclick = () => {
      fullShareCanvas().toBlob(async (blob) => {
        const file = new File([blob], 'nuvola-mood-week.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'My week in Nuvola' }); } catch {} }
      });
    };
  }

  // ---- Tabs ----
  function showTab(t) {
    $('#view-write').classList.toggle('hidden', t !== 'write');
    $('#view-mood').classList.toggle('hidden', t !== 'mood');
    $('#view-you').classList.toggle('hidden', t !== 'you');
    $$('.nav-btn').forEach((b) => {
      const active = b.dataset.tab === t;
      const mobile = b.closest('#nav-mobile');
      b.className = mobile
        ? `nav-btn flex-1 tap flex flex-col items-center justify-center gap-0.5 py-2.5 text-xs ${active ? 'text-sky' : 'text-mist'}`
        : `nav-btn rounded-lg px-3 py-2 text-left ${active ? 'bg-dusk font-medium' : 'hover:bg-dusk/60'}`;
    });
    if (t === 'mood') renderMood();
    if (t === 'you') { renderYouCoach(); renderStats(); }
  }
  $$('.nav-btn').forEach((b) => b.onclick = () => showTab(b.dataset.tab));

  // ---- History sheet (mobile) ----
  $('#history-btn').onclick = () => $('#history-sheet').classList.remove('hidden');
  $('#history-close').onclick = () => $('#history-sheet').classList.add('hidden');
  $('#history-backdrop').onclick = () => $('#history-sheet').classList.add('hidden');

  // ---- Backup ----
  $('#export').onclick = async () => {
    const blob = new Blob([JSON.stringify({ entries: await db.entries.toArray(), checkins: await db.checkins.toArray() }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `nuvola-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#import').onchange = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const entryRows = Array.isArray(data) ? data : data.entries ?? [];
      const checkinRows = Array.isArray(data) ? [] : data.checkins ?? [];
      if (!Array.isArray(entryRows) || !Array.isArray(checkinRows) || entryRows.some((r) => !r || typeof r !== 'object' || (r.diaryText != null && typeof r.diaryText !== 'string'))) throw 0;
      await db.entries.bulkAdd(entryRows.map(({ id, ...r }) => ({ title: 'Untitled', diaryText: '', sentimentScore: null, coachFeedbackText: '', timestamp: Date.now(), ...r })));
      if (checkinRows.length) await db.checkins.bulkAdd(checkinRows.map(({ id, ...r }) => ({ face: 2, timestamp: Date.now(), ...r })));
      refreshList(); renderStreak(); showToast('Backup imported.');
    } catch { showToast("That file doesn't look like a Nuvola backup."); }
  };

  async function renderStats() {
    const [n, c] = await Promise.all([db.entries.count(), db.checkins.count()]);
    $('#you-stats').textContent = `${n} ${n === 1 ? 'entry' : 'entries'} · ${c} check-in${c === 1 ? '' : 's'}, all stored only on this device.`;
  }

  // ---- PWA install ----
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e;
    $('#install-btn').classList.remove('hidden'); $('#install-hint').classList.add('hidden');
  });
  $('#install-btn').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#install-btn').classList.add('hidden'); };
  if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {})); }

  // ---- Init ----
  renderFaces(); renderCheckin(); renderPromptVisibility(); $('#entry-date').textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}); updateWordCount();
  showTab('write'); renderCoachCard(); refreshList(); renderStreak();
  if (coachEnabled && coachSupported) startDownload(coachSize);
})();
