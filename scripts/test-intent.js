#!/usr/bin/env node
// backend/scripts/test-intent.js
// ────────────────────────────────────────────────────────────────────────────────
//  Exercises the assistant's natural-language intent parser against a batch of
//  sample phrasings — no server, no Firebase, no subscriptions written. Uses
//  whichever provider is configured (ANTHROPIC_API_KEY / GROQ_API_KEY /
//  GEMINI_API_KEY), or the keyword fallback if none is set.
//
//  Usage:
//    node scripts/test-intent.js                 # run the built-in test suite
//    node scripts/test-intent.js "open cafes near me, ping me at the closest"
//                                                # parse a single custom phrase
// ────────────────────────────────────────────────────────────────────────────────

'use strict';

const path = require('path');
// Load backend/.env regardless of where the script is invoked from.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { parseAssistantIntent, assistantProvider } = require('../lib/assistantIntent');

const label = (category) => `${category}s`; // mirrors the route's categoryLabel

// text → expected intent (+ optional threshold). `expect: null` = no strong
// expectation (just show what the parser returns).
const CASES = [
  { category: 'salon',      text: 'show me open salons and alert me at the nearest',            expect: 'subscribe_nearest' },
  { category: 'cafe',       text: 'which cafes are open right now',                             expect: 'list_available' },
  { category: 'salon',      text: 'ping me at the closest salon with fewer than 2 people',      expect: 'subscribe_nearest', threshold: 2 },
  { category: 'gym',        text: 'notify me when a nearby gym is empty',                       expect: 'subscribe_nearest' },
  { category: 'restaurant', text: 'any restaurants with free tables near me?',                  expect: 'list_available' },
  { category: 'clinic',     text: 'let me know when the clinic wait is short',                  expect: 'subscribe_nearest' },
  { category: 'salon',      text: 'book me a haircut for tomorrow at 5pm',                      expect: 'unsupported' },
  { category: 'cafe',       text: "what's the weather today",                                   expect: 'unsupported' },
];

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED   = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM   = (s) => `\x1b[2m${s}\x1b[0m`;

async function runOne(text, category) {
  const started = Date.now();
  const result = await parseAssistantIntent(text, label(category), {
    onError: (err) => console.error(RED(`  provider error: ${err.message}`)),
  });
  return { result, ms: Date.now() - started };
}

async function main() {
  const provider = assistantProvider();
  console.log(`\nAssistant provider: ${provider === 'keyword' ? RED(provider) : GREEN(provider)}`);
  if (provider === 'keyword') {
    console.log(DIM('  (no API key set — testing the keyword fallback. Set GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY to test an LLM.)'));
  }
  console.log('');

  // Single-phrase mode.
  const custom = process.argv.slice(2).join(' ').trim();
  if (custom) {
    const { result, ms } = await runOne(custom, 'salon');
    console.log(`"${custom}"`);
    console.log(`  → ${JSON.stringify(result)}  ${DIM(ms + 'ms')}`);
    return;
  }

  // Suite mode.
  let pass = 0;
  const fails = [];
  for (const c of CASES) {
    const { result, ms } = await runOne(c.text, c.category);
    const intentOk = c.expect == null || result.intent === c.expect;
    const thrOk    = c.threshold == null || result.threshold === c.threshold;
    const ok = intentOk && thrOk;
    if (ok) pass++; else fails.push({ c, result });

    const mark = ok ? GREEN('PASS') : RED('FAIL');
    const want = [c.expect, c.threshold != null ? `thr=${c.threshold}` : null].filter(Boolean).join(', ');
    console.log(`${mark}  [${c.category}] "${c.text}"`);
    console.log(`      got: intent=${result.intent} availableOnly=${result.availableOnly} threshold=${result.threshold}` +
                (c.expect ? DIM(`   want: ${want}`) : '') + `  ${DIM(ms + 'ms')}`);
  }

  console.log(`\n${pass}/${CASES.length} passed` + (fails.length ? RED(`, ${fails.length} failed`) : GREEN(' ✓')));
  if (provider === 'keyword' && fails.length) {
    console.log(DIM('  (keyword mode can\'t detect "unsupported" or unusual phrasings — set an LLM key for those.)'));
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error(RED('\nUnexpected error:'), err);
  process.exit(1);
});
