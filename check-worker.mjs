
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
import { CreateMLCEngine } from 'https://esm.run/@mlc-ai/web-llm@0.2.79';
import { Analytics } from "@vercel/analytics/next"

env.allowLocalModels = false;
env.useBrowserCache = true;

const COACH_PROMPT = `You are a warm, private journaling coach. Everything stays on the user's device.
Rules: reply in at most 4 short sentences. Reflect one feeling you notice, validate it, then offer ONE gentle, concrete suggestion or question.
Never diagnose, never give medical advice, never lecture. If the user mentions self-harm, kindly encourage reaching out to a trusted person or local crisis line.`;

// SST-2 only yields positive/negative, so valence is spread across emotions with a small lexicon.
const LEXICON = {
  joy: ['happy','joy','excited','grateful','love','proud','fun','great','wonderful','laugh'],
  sadness: ['sad','cry','lonely','miss','lost','grief','tired','empty','hurt','down'],
  anger: ['angry','mad','furious','annoyed','hate','unfair','frustrated','rage'],
  fear: ['afraid','scared','anxious','worried','nervous','panic','stress','dread'],
  calm: ['calm','peace','relaxed','quiet','rested','content','gentle','slow'],
};
let classifier = null, engine = null, engineModel = null, busy = false;
const post = (type, p = {}) => self.postMessage({ type, ...p });

async function loadSentiment() {
  classifier ??= await pipeline('text-classification', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', {
    progress_callback: (p) => { if (p.status === 'progress') post('progress', { stage: 'sentiment', progress: (p.progress ?? 0) / 100, text: 'Mood model: ' + p.file }); },
  });
}
async function loadCoach(modelId) {
  if (!('gpu' in navigator)) throw new Error("WebGPU isn't available in this browser.");
  if (engine && engineModel === modelId) return;
  engine = await CreateMLCEngine(modelId, { initProgressCallback: (r) => post('progress', { stage: 'coach', progress: r.progress, text: r.text }) });
  engineModel = modelId;
}
async function analyze(id, text) {
  await loadSentiment();
  const [{ label, score }] = await classifier(text.slice(0, 2000));
  const valence = label === 'POSITIVE' ? score : 1 - score;
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const raw = Object.fromEntries(Object.entries(LEXICON).map(([k, l]) => [k, words.filter((w) => l.includes(w)).length]));
  const bias = { joy: valence, calm: valence * 0.6, sadness: 1 - valence, anger: (1 - valence) * 0.5, fear: (1 - valence) * 0.5 };
  const mix = Object.fromEntries(Object.keys(raw).map((k) => [k, bias[k] + raw[k] * 0.5]));
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  const emotions = Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, +(v / total).toFixed(3)]));
  post('sentiment', { id, result: { label, score, valence, emotions } });
}
async function coach(id, text, sentiment, modelId) {
  await loadCoach(modelId);
  const hint = sentiment ? `\n(Detected tone: ${sentiment.label.toLowerCase()}.)` : '';
  const stream = await engine.chat.completions.create({
    stream: true, temperature: 0.7, max_tokens: 220,
    messages: [{ role: 'system', content: COACH_PROMPT }, { role: 'user', content: `My diary entry:\n"""\n${text.slice(0, 4000)}\n"""${hint}` }],
  });
  let full = '';
  for await (const chunk of stream) {
    const d = chunk.choices[0]?.delta?.content ?? '';
    if (d) { full += d; post('token', { id, delta: d }); }
  }
  post('done', { id, text: full });
}
self.onmessage = async ({ data }) => {
  const { type, id, text, sentiment, modelId } = data;
  try {
    if (type === 'analyze') await analyze(id, text);
    else if (type === 'coach') {
      if (busy) return post('error', { id, message: "The coach is still replying to something else — one moment." });
      busy = true;
      try { await coach(id, text, sentiment, modelId); } finally { busy = false; }
    } else if (type === 'interrupt') engine?.interruptGenerate();
    else if (type === 'warmup') { await loadSentiment(); await loadCoach(modelId); post('ready', { modelId }); }
  } catch (e) { busy = false; post('error', { id, message: e?.message ?? String(e) }); }
};
