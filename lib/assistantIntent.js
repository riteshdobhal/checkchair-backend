// backend/lib/assistantIntent.js
// ════════════════════════════════════════════════════════════════════════════════
//  Natural-language intent parsing for the CheckChair assistant.
//
//  The assistant only needs to CLASSIFY intent — a cheap, well-scoped task — so it
//  works with any of several backends, chosen by whichever API key is present:
//    ANTHROPIC_API_KEY → Claude  (paid)
//    GROQ_API_KEY       → Groq    (free tier, OpenAI-compatible)  ← https://console.groq.com
//    GEMINI_API_KEY     → Gemini  (free tier)                     ← https://aistudio.google.com
//    (none)             → built-in keyword parser (no network, no key)
//
//  Kept in its own module (no Firebase / Express deps) so it can be unit-tested in
//  isolation — see scripts/test-intent.js.
// ════════════════════════════════════════════════════════════════════════════════

'use strict';

const ASSISTANT_INTENTS = ['subscribe_nearest', 'list_available', 'unsupported'];

const ASSISTANT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'; // cheapest Claude tier
const GROQ_MODEL      = process.env.GROQ_MODEL      || 'llama-3.3-70b-versatile';
const GEMINI_MODEL    = process.env.GEMINI_MODEL    || 'gemini-2.0-flash';

// Lazily-created Anthropic client (only when ANTHROPIC_API_KEY is set).
let _anthropic;
function getAnthropic() {
  if (_anthropic === undefined) {
    if (process.env.ANTHROPIC_API_KEY) {
      const Anthropic = require('@anthropic-ai/sdk');
      _anthropic = new Anthropic();
    } else {
      _anthropic = null;
    }
  }
  return _anthropic;
}

/** Returns the provider that parseAssistantIntent() will use, given current env. */
function assistantProvider() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY)      return 'groq';
  if (process.env.GEMINI_API_KEY)    return 'gemini';
  return 'keyword';
}

/** System prompt shared across every LLM provider. */
function assistantSystemPrompt(categoryLabel) {
  return (
    `You parse a customer's request in CheckChair, an app that shows live occupancy for ${categoryLabel} ` +
    `and lets customers subscribe to a push alert when a busy place frees up. ` +
    `The customer is currently browsing ${categoryLabel}. Extract their intent as structured data.\n\n` +
    `Return JSON with exactly these keys:\n` +
    `- intent: one of "subscribe_nearest" (wants to be alerted/subscribed at the nearest place with free seats), ` +
    `"list_available" (only wants to see which places are open), or "unsupported" (anything this app can't do).\n` +
    `- availableOnly: boolean — true if they only care about places that currently have free seats.\n` +
    `- threshold: integer — the app sends the alert when the current number of people is BELOW this value. ` +
    `If the user says "fewer than N", "less than N", "under N", or "below N", set threshold to N. Use 0 if they didn't specify a number.`
  );
}

/** Coerce any provider's raw JSON into a safe, well-typed intent object. */
function normalizeIntent(raw, source) {
  const intent = ASSISTANT_INTENTS.includes(raw && raw.intent) ? raw.intent : 'list_available';
  const threshold = Number.isFinite(raw && raw.threshold) ? Math.max(0, Math.trunc(raw.threshold)) : 0;
  return { intent, availableOnly: Boolean(raw && raw.availableOnly), threshold, source };
}

/** Anthropic Claude via structured outputs. */
async function parseWithAnthropic(text, categoryLabel) {
  const response = await getAnthropic().messages.create({
    model:      ASSISTANT_MODEL,
    max_tokens: 300,
    output_config: {
      // NB: the `effort` parameter is not supported on Haiku 4.5 — omit it here.
      format: {
        type:   'json_schema',
        name:   'assistant_intent',
        schema: {
          type: 'object',
          properties: {
            intent:        { type: 'string', enum: ASSISTANT_INTENTS },
            availableOnly: { type: 'boolean' },
            threshold:     { type: 'integer' },
          },
          required: ['intent', 'availableOnly', 'threshold'],
          additionalProperties: false,
        },
      },
    },
    system:   assistantSystemPrompt(categoryLabel),
    messages: [{ role: 'user', content: text }],
  });
  const block = response.content.find((b) => b.type === 'text');
  return normalizeIntent(JSON.parse(block.text), 'anthropic');
}

/** Groq (free tier) via its OpenAI-compatible chat completions + JSON mode. */
async function parseWithGroq(text, categoryLabel) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:           GROQ_MODEL,
      temperature:     0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: assistantSystemPrompt(categoryLabel) },
        { role: 'user',   content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return normalizeIntent(JSON.parse(data.choices[0].message.content), 'groq');
}

/** Google Gemini (free tier) via generateContent with a JSON response schema. */
async function parseWithGemini(text, categoryLabel) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: assistantSystemPrompt(categoryLabel) }] },
      contents:          [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature:      0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            intent:        { type: 'STRING', enum: ASSISTANT_INTENTS },
            availableOnly: { type: 'BOOLEAN' },
            threshold:     { type: 'INTEGER' },
          },
          required: ['intent', 'availableOnly', 'threshold'],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const out  = data.candidates[0].content.parts[0].text;
  return normalizeIntent(JSON.parse(out), 'gemini');
}

/** Zero-cost fallback: regex keyword matching. Keeps the feature alive with no key. */
function keywordIntent(text) {
  const t = (text || '').toLowerCase();
  const wantsAlert   = /alert|notif|subscrib|tell me|let me know|remind|ping me|buzz|text me/.test(t);
  const wantsOpen    = /open|available|free|empty|quiet|seat|walk\s?in|not busy/.test(t);
  const thresholdHit = t.match(/(?:fewer than|less than|under|below)\s*(\d+)/);
  return normalizeIntent(
    {
      intent:        wantsAlert ? 'subscribe_nearest' : 'list_available',
      availableOnly: wantsOpen || wantsAlert,
      threshold:     thresholdHit ? parseInt(thresholdHit[1], 10) : 0,
    },
    'keyword',
  );
}

/**
 * Parse a customer's free-text request into a structured intent, using the first
 * configured provider (Claude → Groq → Gemini) and falling back to keyword matching
 * if none is configured or the provider call fails.
 *
 * @param {string} text          - The user's raw request.
 * @param {string} categoryLabel - Plural category label for the prompt, e.g. "salons".
 * @param {{ onError?: (err: Error) => void }} [opts] - Optional error hook (for logging).
 * @returns {Promise<{ intent: string, availableOnly: boolean, threshold: number, source: string }>}
 */
async function parseAssistantIntent(text, categoryLabel, opts = {}) {
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  try {
    const provider = assistantProvider();
    if (provider === 'anthropic') return await parseWithAnthropic(text, categoryLabel);
    if (provider === 'groq')      return await parseWithGroq(text, categoryLabel);
    if (provider === 'gemini')    return await parseWithGemini(text, categoryLabel);
  } catch (err) {
    onError(err);
    // fall through to keyword parsing
  }
  return keywordIntent(text);
}

module.exports = {
  parseAssistantIntent,
  assistantProvider,
  keywordIntent,
  normalizeIntent,
  ASSISTANT_INTENTS,
};
