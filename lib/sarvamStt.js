// backend/lib/sarvamStt.js
// ════════════════════════════════════════════════════════════════════════════════
//  Speech-to-text via Sarvam AI (https://docs.sarvam.ai) — Saaras/Saarika models,
//  purpose-built for Indian-language ASR (far better than on-device recognizers for
//  Hindi/Tamil/Telugu/Kannada, which is what the customer-facing mic button needs).
//
//  Kept in its own module (no Express deps) so it can be unit-tested in isolation,
//  same pattern as lib/assistantIntent.js.
// ════════════════════════════════════════════════════════════════════════════════

'use strict';

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_MODEL    = process.env.SARVAM_STT_MODEL || 'saaras:v3';

/** True when SARVAM_API_KEY is configured — callers use this to no-op cleanly. */
function sttEnabled() {
  return Boolean(process.env.SARVAM_API_KEY);
}

/**
 * Transcribe a recorded audio clip with Sarvam.
 *
 * @param {Buffer} audioBuffer     - Raw audio bytes (m4a/wav/webm/etc — Sarvam auto-detects).
 * @param {string} filename        - Original filename, used only to hint the codec (e.g. "clip.m4a").
 * @param {string} mimetype        - Content-Type of the audio, e.g. "audio/mp4".
 * @param {string} [languageCode]  - BCP-47 code, e.g. "hi-IN". Omit/'unknown' to let Sarvam auto-detect.
 * @returns {Promise<{ transcript: string, languageCode: string|null }>}
 */
async function transcribeAudio(audioBuffer, filename, mimetype, languageCode) {
  if (!sttEnabled()) {
    throw new Error('SARVAM_API_KEY is not configured');
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimetype || 'audio/mp4' }), filename || 'audio.m4a');
  form.append('model', SARVAM_MODEL);
  form.append('mode', 'transcribe');
  if (languageCode && languageCode !== 'unknown') {
    form.append('language_code', languageCode);
  }

  const res = await fetch(SARVAM_STT_URL, {
    method:  'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
    body:    form,
  });

  if (!res.ok) {
    throw new Error(`Sarvam HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return {
    transcript:   (data.transcript || '').trim(),
    languageCode: data.language_code || null,
  };
}

module.exports = { transcribeAudio, sttEnabled, SARVAM_MODEL };
