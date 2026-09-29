const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = 'gemini-3.7-flash';
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function extractText(data) {
  return (data?.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || '')
    .join('')
    .trim();
}

async function callGemini(model, key, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let last = null;

  // A brief retry handles transient capacity spikes before moving to a fallback model.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { response, data };

    last = { status: response.status, data };
    if (!RETRYABLE_STATUSES.has(response.status)) return last;
    if (attempt === 0) await new Promise(r => setTimeout(r, 900));
  }
  return last;
}

app.post('/api/ai', async (req, res) => {
  const { prompt, system, mode = 'text', apiKey, model } = req.body || {};
  const key = String(apiKey || '').trim();
  const requestedModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });
  if (!key) return res.status(401).json({ error: 'Gemini API key is required. Add your key using the API Key button.' });
  if (key.length < 10) return res.status(400).json({ error: 'The Gemini API key looks incomplete.' });

  const body = {
    systemInstruction: { parts: [{ text: system || 'You are a helpful, accurate educational assistant.' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {}
  };

  if (mode === 'json') body.generationConfig.responseMimeType = 'application/json';

  // Gemini can temporarily return 503 when a model is at capacity. Try the selected
  // model first, then stable Flash fallbacks so a temporary spike does not break the app.
  const models = [...new Set([requestedModel, ...FALLBACK_MODELS])];

  try {
    let lastFailure = null;
    for (const selectedModel of models) {
      const result = await callGemini(selectedModel, key, body);
      if (result?.response?.ok) {
        const output = extractText(result.data);
        if (!output) return res.status(502).json({ error: `Gemini (${selectedModel}) returned no text response.` });
        return res.json({ output, model: selectedModel, requestedModel, fallbackUsed: selectedModel !== requestedModel, mode });
      }

      lastFailure = result;
      const status = result?.status;
      // Invalid key/model/permission errors should be shown immediately instead of
      // trying unrelated models. Capacity/rate-limit errors are the ones we can recover from.
      if (![429, 500, 502, 503, 504].includes(status)) break;
    }

    const status = lastFailure?.status || 502;
    const apiMessage = lastFailure?.data?.error?.message || '';
    if (status === 503) {
      return res.status(503).json({
        error: 'Gemini is temporarily at capacity. The app already tried the selected model and fallback Flash models. Please wait a little and try again.',
        detail: apiMessage
      });
    }
    if (status === 429) {
      return res.status(429).json({
        error: 'Gemini rate limit or free-tier quota reached. Please wait for the quota window to reset, or try another Gemini model.',
        detail: apiMessage
      });
    }
    return res.status(status).json({ error: apiMessage || `Gemini API request failed (${status}).` });
  } catch (error) {
    console.error('Gemini request error:', error.message);
    res.status(502).json({ error: 'Could not reach Gemini. Check your internet connection and try again.' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, provider: 'Gemini', model: DEFAULT_MODEL, fallbacks: FALLBACK_MODELS }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`AI Student Assistant — Gemini: http://localhost:${PORT}`));
