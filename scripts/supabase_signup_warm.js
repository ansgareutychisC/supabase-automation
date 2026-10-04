#!/usr/bin/env node
/* Supabase signup through the shared warm-browser cascade.
 *
 * The signup endpoint POST https://api.supabase.com/platform/signup requires
 * an hCaptcha token (sitekey 4ca1fdb9-…) validated server-side. The SPA
 * form at supabase.com/dashboard/sign-up runs hCaptcha in-page — in a warm
 * (residential/stealth) browser the invisible check usually passes and the
 * form's own POST carries the solved token. We detect the 201.
 *
 * RISK: interactive hCaptcha challenges (image cards) cannot be solved
 * headlessly — if hCaptcha escalates, the attempt fails; the retry loop
 * rotates to a fresh session/IP (hCaptcha pass mode is reputation-based).
 *
 * Everything AFTER the 201 is plain HTTP in the Python driver:
 * v3-mail poll -> verify link (strip redirect_to) -> #access_token fragment.
 *
 * Usage:
 *   NODE_PATH=/home/z/.npm-global/lib/node_modules \
 *   ONBOARD_COMMON_ROOT=/path/to/onboard-automation-common \
 *   node scripts/supabase_signup_warm.js [--email x@v3-mail.priv.email] \
 *     [--tier auto|local|zenrows] [--country us] [--attempts 3] [--out f.json]
 * Env: ZENROWS_API_KEY, SUPABASE_MAIL_DOMAIN (default v3-mail.priv.email)
 */
const fs = require('fs');
const path = require('path');

const COMMON = process.env.ONBOARD_COMMON_ROOT ||
  path.resolve(__dirname, '..', '..', 'onboard-automation-common');
const W = require(path.join(COMMON, 'scripts', 'warm_browser.js'));

const MAIL_DOMAIN = process.env.SUPABASE_MAIL_DOMAIN || 'v3-mail.priv.email';
const SIGNUP_URL = 'https://supabase.com/dashboard/sign-up';

const args = Object.fromEntries(process.argv.slice(2).map((s, i, a) =>
  s.startsWith('--') ? [s.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true] : []));
const OUT = args.out || '/tmp/supabase_warm_creds.json';
const ATTEMPTS = parseInt(args.attempts || '3', 10);
const TIER = args.tier || 'auto';
let tier = TIER;   // mutable: escalates local -> zenrows on flow failure

function freshEmail() {
  return `sb-warm-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 8)}@${MAIL_DOMAIN}`;
}
function genPassword() {
  const alpha = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pw = '';
  for (let i = 0; i < 16; i++) pw += alpha[Math.floor(Math.random() * alpha.length)];
  return '-Sb' + pw + '!7';
}

async function runAttempt(email, password) {
  const { browser, ctx, tier: usedTier } = await W.connect(tier, { country: args.country || 'us' });
  try {
    await W.wipeCookies(ctx);
    const page = await ctx.newPage();

    // intercept the platform signup response BEFORE navigating
    let signupStatus = null;
    let signupErr = '';
    page.on('response', async (res) => {
      try {
        if (res.url().includes('api.supabase.com/platform/signup') &&
            res.request().method() === 'POST') {
          signupStatus = res.status();
          if (res.status() !== 201) signupErr = (await res.text()).slice(0, 200);
        }
      } catch (e) { /* consumed */ }
    });

    await W.navCommit(page, SIGNUP_URL);
    if (!(await W.waitChallenge(page, 'signup'))) throw new Error('CF challenge did not clear');

    const ready = await W.navReady(page,
      `() => !!document.querySelector('input[autocomplete="email"]')`, 60000);
    if (!ready) throw new Error('signup form never became ready');

    // fill the two fields (React Router form: autocomplete selectors are
    // the stable contract; ids are per-build _R_* hashes)
    await page.locator('input[autocomplete="email"]').first().fill(email);
    await page.locator('input[autocomplete="new-password"]').first().fill(password);
    W.log('form', 'filled email + password');

    const btn = page.locator('button[type="submit"], button:has-text("Sign Up"), button:has-text("Sign up")').first();
    if (await btn.count() && await btn.isVisible().catch(() => false)) await btn.click();
    else await page.keyboard.press('Enter');
    W.log('form', 'submitted (hCaptcha executing in-page ...)');

    const t0 = Date.now();
    while (signupStatus === null && Date.now() - t0 < 120000) {
      await page.waitForTimeout(3000);
      // hCaptcha invisible mode takes 2-10s; interactive mode would stall
      // until timeout (unsolvable headlessly)
    }
    if (signupStatus === null) {
      throw new Error('no platform/signup response in 120s — hCaptcha likely served an interactive challenge');
    }
    if (signupStatus !== 201) {
      throw new Error(`platform/signup HTTP ${signupStatus}: ${signupErr}`);
    }
    W.log('form', 'signup 201 — account created, verification email sent');

    const ip = await W.traceIp(page).catch(() => null);
    const cookies = {};
    try {
      for (const c of await ctx.cookies('https://supabase.com')) cookies[c.name] = c.value;
    } catch (e) { /* CDP cookie API may differ */ }
    await W.exportState(ctx, OUT.replace(/\.json$/, '.state.json'));

    return {
      service: 'supabase', email, password, cookies,
      signupIp: ip, proxyCountry: args.country || 'us', tier: usedTier,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  W.log('start', `tier=${TIER} attempts=${ATTEMPTS}`);
  let lastErr;
  for (let a = 1; a <= ATTEMPTS; a++) {
    const email = typeof args.email === 'string' && a === 1 ? args.email : freshEmail();
    try {
      const creds = await runAttempt(email, genPassword());
      fs.writeFileSync(OUT, JSON.stringify(creds, null, 2));
      W.log('done', `creds -> ${OUT}`);
      console.log('\n*** SUPABASE WARM SIGNUP SUBMITTED ***');
      console.log(JSON.stringify(creds, null, 2));
      return;
    } catch (e) {
      lastErr = e;
      W.log('attempt', `${a}/${ATTEMPTS} failed (tier=${tier}): ${e.message}`);
      if (tier !== 'zenrows') {
        tier = 'zenrows';           // doctrine: escalate, never stay on a
        W.log('tier', 'escalating to zenrows for next attempts');  // failing free tier
      }
      if (a < ATTEMPTS) await new Promise((r) => setTimeout(r, 12000));
    }
  }
  throw lastErr;
}

main().catch((e) => { console.error('[FAIL]', e && (e.stack || e.message)); process.exit(1); });
