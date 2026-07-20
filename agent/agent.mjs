/**
 * ============================================================
 * MERIDIAN & CO. — Autonomous Investment Agent (paper trading)
 * ============================================================
 * Runs on a GitHub Actions schedule. Each cycle it:
 *   1. Marks open positions to market (live web search)
 *   2. Checks the mode's circuit breaker — in code, not AI
 *   3. Asks the AI committee for ONE decision, with evidence
 *   4. Enforces risk rules, executes in the paper portfolio
 *   5. Saves state + ledger (committed back to the repo)
 *   6. Optionally notifies a Discord webhook
 *
 * After the close (>= 21:00 UTC) it files the daily report
 * instead of trading.
 *
 * This is an educational paper-trading system. It is not
 * financial advice and cannot guarantee returns.
 * ============================================================
 */

import { readFileSync, writeFileSync } from "node:fs";

/* ----------------------- files & env ----------------------- */
const STATE_PATH = "docs/data/state.json"; // served by GitHub Pages for the dashboard
const CONFIG_PATH = "config.json";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null; // AI provider option A
const GEMINI_KEY = process.env.GEMINI_API_KEY || null;        // AI provider option B (free tier)
const GROQ_KEY = process.env.GROQ_API_KEY || null;            // AI provider option C (free, no search)
const DISCORD = process.env.DISCORD_WEBHOOK || null;   // optional
const MARKETAUX = process.env.MARKETAUX_API_KEY || null; // optional news feed
const FINNHUB = process.env.FINNHUB_API_KEY || null;     // optional news feed + earnings
const FRED = process.env.FRED_API_KEY || null;           // optional macro data + VIX

/* ----------------------- mode definitions ------------------ */
const MODES = {
  conservative: { label: "Conservative", breaker: 0.20, target: "15-20%/qtr (aspirational)",
    tone: "Capital preservation first. Blue chips, ETFs, low volatility, high-conviction only, broad diversification, low trade frequency." },
  liberal:      { label: "Liberal",      breaker: 0.35, target: "20-27%/qtr (aspirational)",
    tone: "Balanced growth, moderate risk tolerance, balanced portfolio, medium trade frequency." },
  aggressive:   { label: "Aggressive",   breaker: 0.50, target: "27-35%/qtr (aspirational)",
    tone: "Maximum growth within defined risk controls. Growth, momentum, sector rotation, higher volatility accepted." },
};

/* ----------------------- state I/O ------------------------- */
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const state  = JSON.parse(readFileSync(STATE_PATH, "utf8"));
const mode   = MODES[config.mode] || MODES.conservative;

/* ----------------------- AI provider selection -------------- */
/**
 * Hybrid brain: "provider" in config.json chooses "gemini" (free
 * tier, Google Search grounding) or "anthropic" (Claude, paid).
 * If the configured provider's key is missing but the other's is
 * present, the agent falls back rather than dying — flip one
 * config value any time to switch; nothing else changes.
 */
const AI_KEYS = { anthropic: ANTHROPIC_KEY, gemini: GEMINI_KEY, groq: GROQ_KEY };
let PROVIDER = (config.provider || "anthropic").toLowerCase();
if (!AI_KEYS[PROVIDER]) {
  // Configured provider has no key: use whichever key exists, best brain first.
  PROVIDER = ["anthropic", "gemini", "groq"].find((p) => AI_KEYS[p]);
}
if (!PROVIDER) {
  console.error("No AI key found. Add ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY as a repo secret.");
  process.exit(1);
}
/** Groq's free models have no live search — the seven data feeds carry
 *  the current-events load, and prompts are adjusted automatically. */
const CAN_SEARCH = PROVIDER !== "groq";
console.log(`AI provider: ${PROVIDER}${CAN_SEARCH ? "" : " (no live search — feed-driven mode)"}`);
const now    = new Date();
const todayISO = now.toISOString().slice(0, 10);

function save() {
  state.lastRun = now.toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/* ----------------------- helpers --------------------------- */
const usd = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const holdingsValue = () => state.positions.reduce((s, p) => s + p.shares * p.price, 0);
const totalValue    = () => state.cash + holdingsValue();
const drawdown      = () => Math.max(0, (config.startingValue - totalValue()) / config.startingValue);

/** Count trades already executed today (enforces maxDailyTrades). */
const tradesToday = () => state.ledger.filter((t) => t.time.slice(0, 10) === todayISO).length;

/** Rough US market-hours guard (UTC). The cron already limits runs;
 *  this is a second line of defense. Weekends always skip. */
function marketLikelyOpen() {
  const d = now.getUTCDay(), h = now.getUTCHours() + now.getUTCMinutes() / 60;
  return d >= 1 && d <= 5 && h >= 13.5 && h < 20.25;
}

/* ----------------------- AI API (dual provider) ------------ */
/**
 * One call to the configured AI with live search, demanding strict
 * JSON. Same contract for both providers — the rest of the agent
 * neither knows nor cares which brain answered. Retries once.
 */
async function askCommittee(prompt, maxTokens = 2000) {
  const full = prompt +
    "\n\nRespond with ONLY one valid JSON object. No markdown fences, no prose outside the JSON. Keep strings concise.";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const adapted = CAN_SEARCH ? full :
        full.split("live web search").join("the data briefs provided above") +
        "\nNote: you have NO web search. Reason ONLY from the briefs above and your general knowledge; do not invent current events or prices.";
      const text = PROVIDER === "gemini" ? await callGemini(adapted, maxTokens)
                 : PROVIDER === "groq"   ? await callGroq(adapted, maxTokens)
                 : await callClaude(adapted, maxTokens);
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      if (s === -1) throw new Error("no JSON in reply");
      return JSON.parse(text.slice(s, e + 1).replace(/```/g, ""));
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn("AI attempt failed, retrying:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Anthropic (Claude) with the web_search tool. */
async function callClaude(full, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: full }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/** Google Gemini (free tier) with Google Search grounding. */
async function callGemini(full, maxTokens) {
  const model = config.geminiModel || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: full }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 2000), temperature: 0.4 },
      }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Gemini API error");
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
}

/** Groq (free tier, OpenAI-compatible, no search) running open models. */
async function callGroq(full, maxTokens) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: config.groqModel || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: full }],
      max_tokens: Math.max(maxTokens, 2000),
      temperature: 0.4,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Groq API error");
  return data.choices?.[0]?.message?.content || "";
}

/* ----------------------- news feeds ------------------------ */
/**
 * Pulls headlines from Marketaux and/or Finnhub (whichever keys
 * exist), deduplicates them, and returns a compact brief the
 * committee reads before deciding. Both feeds are optional —
 * with neither key, the committee relies on web search alone.
 */
let newsBrief = []; // filled once per run, read by committeeContext()

async function gatherNews() {
  const items = [];
  const held = state.positions.map((p) => p.ticker);
  const universe = [...new Set([...held, ...config.watchlist])];

  // --- Marketaux: multi-source coverage + per-article sentiment ---
  if (MARKETAUX) {
    try {
      const url = `https://api.marketaux.com/v1/news/all?symbols=${universe.slice(0, 10).join(",")}` +
                  `&filter_entities=true&language=en&limit=3&api_token=${MARKETAUX}`;
      const d = await (await fetch(url)).json();
      for (const a of d.data || []) {
        const ent = (a.entities || [])[0];
        items.push({
          head: a.title,
          sym: (a.entities || []).map((e) => e.symbol).filter(Boolean).join("/") || "MKT",
          sent: ent && ent.sentiment_score != null ? Number(ent.sentiment_score).toFixed(2) : null,
          src: "marketaux",
        });
      }
    } catch (e) { console.warn("Marketaux fetch failed:", e.message); }
  }

  // --- Finnhub: fast general-market + company-specific headlines ---
  if (FINNHUB) {
    try {
      const gen = await (await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB}`)).json();
      for (const a of (Array.isArray(gen) ? gen : []).slice(0, 5)) {
        items.push({ head: a.headline, sym: a.related || "MKT", sent: null, src: "finnhub" });
      }
    } catch (e) { console.warn("Finnhub general news failed:", e.message); }
    // Company news for current holdings (they matter most); capped to
    // stay well inside Finnhub's free-tier rate limit.
    const from = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    for (const sym of held.slice(0, 6)) {
      try {
        const d = await (await fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${from}&to=${todayISO}&token=${FINNHUB}`)).json();
        for (const a of (Array.isArray(d) ? d : []).slice(0, 2)) {
          items.push({ head: a.headline, sym, sent: null, src: "finnhub" });
        }
      } catch (e) { console.warn(`Finnhub news for ${sym} failed:`, e.message); }
    }
  }

  // Deduplicate near-identical headlines across the two feeds.
  const seen = new Set();
  newsBrief = items.filter((i) => {
    if (!i.head) return false;
    const k = i.head.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 18);
  if (newsBrief.length) console.log(`News brief: ${newsBrief.length} headlines gathered.`);
}

/* ----------------------- computed technicals --------------- */
/**
 * Real quantitative pattern data, computed locally from free
 * Stooq daily price history (no key needed). For each symbol in
 * the universe: trend vs 50d/200d averages, RSI-14, ATR-14
 * volatility, distance from the 52-week high, and 20-day return.
 * These are measured numbers, not AI estimates — the committee
 * gets facts to reason from. Also keeps each symbol's last close
 * as a price fallback if the AI mark-to-market misses one.
 * Fails soft per symbol, like every other feed.
 */
let techBrief = "";
const stooqClose = {}; // ticker -> last daily close (fallback pricing)

async function gatherTechnicals() {
  const universe = [...new Set(["SPY", ...state.positions.map((p) => p.ticker), ...config.watchlist])].slice(0, 11);
  const lines = [];
  for (const sym of universe) {
    try {
      const csv = await (await fetch(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`)).text();
      const rows = csv.trim().split("\n").slice(1).map((r) => r.split(","));
      if (rows.length < 60) continue; // not enough history to compute anything honest
      const closes = rows.map((r) => +r[4]).filter((n) => n > 0);
      const last = closes[closes.length - 1];
      stooqClose[sym] = last;

      const sma = (n) => { const s = closes.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; };
      // RSI-14 from the last 14 daily changes
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        d > 0 ? (gains += d) : (losses -= d);
      }
      const rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
      // ATR-14 from true ranges
      let atr = 0;
      for (let i = rows.length - 14; i < rows.length; i++) {
        const h = +rows[i][2], lo = +rows[i][3], pc = +rows[i - 1][4];
        atr += Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
      }
      atr /= 14;
      const hi52 = Math.max(...closes.slice(-252));
      const r20 = (last / closes[closes.length - 21] - 1) * 100;

      lines.push(`${sym}: close ${last.toFixed(2)}, ${last >= sma(50) ? "ABOVE" : "BELOW"} 50d avg, ${last >= sma(200) ? "ABOVE" : "BELOW"} 200d avg, RSI14 ${rsi.toFixed(0)}, ATR ${(atr / last * 100).toFixed(1)}%/day, ${((last / hi52 - 1) * 100).toFixed(1)}% vs 52w high, 20d ${r20 >= 0 ? "+" : ""}${r20.toFixed(1)}%`);
    } catch (e) { console.warn(`stooq ${sym} failed:`, e.message); }
  }
  techBrief = lines.join("\n");
  if (techBrief) console.log(`Technicals computed for ${lines.length} symbols.`);
}

/* ----------------------- macro, filings, earnings ---------- */
/**
 * Three more optional intelligence feeds, all free:
 *  - FRED (St. Louis Fed): hard macro numbers + the VIX close
 *  - SEC EDGAR: fresh 8-K material-event filings for holdings
 *  - Finnhub earnings calendar: who in our universe reports soon
 * Each fails soft — a dead feed logs a warning and the cycle
 * continues without it.
 */
let macroBrief = "", filingsBrief = "", earningsBrief = "";

async function gatherMacro() {
  if (!FRED) return;
  // series: fed funds rate, unemployment, 10y-2y curve, VIX close, CPI (13 months for YoY math)
  const series = { DFF: "Fed funds rate", UNRATE: "Unemployment", T10Y2Y: "10y-2y yield spread", VIXCLS: "VIX close" };
  const parts = [];
  for (const [id, label] of Object.entries(series)) {
    try {
      const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&sort_order=desc&limit=1`;
      const d = await (await fetch(u)).json();
      const v = d?.observations?.[0]?.value;
      if (v && v !== ".") parts.push(`${label}: ${v}${id === "VIXCLS" ? "" : "%"} (as of ${d.observations[0].date})`);
    } catch (e) { console.warn(`FRED ${id} failed:`, e.message); }
  }
  try { // CPI year-over-year from the index level, 13 months back
    const u = `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=${FRED}&file_type=json&sort_order=desc&limit=13`;
    const d = await (await fetch(u)).json();
    const o = d?.observations || [];
    if (o.length >= 13) {
      const yoy = ((+o[0].value / +o[12].value - 1) * 100).toFixed(1);
      parts.push(`CPI inflation: ${yoy}% YoY (through ${o[0].date})`);
    }
  } catch (e) { console.warn("FRED CPI failed:", e.message); }
  macroBrief = parts.join("; ");
  if (macroBrief) console.log("Macro brief:", macroBrief);
}

async function gatherFilings() {
  const held = state.positions.map((p) => p.ticker);
  if (!held.length) return;
  const UA = { "User-Agent": "MeridianAgent/1.0 (educational paper-trading; github hosted)" };
  try {
    // Map tickers to SEC CIK numbers, then check each holding's recent filings.
    const map = await (await fetch("https://www.sec.gov/files/company_tickers.json", { headers: UA })).json();
    const byTicker = {};
    for (const k of Object.keys(map)) byTicker[map[k].ticker] = String(map[k].cik_str).padStart(10, "0");
    const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const hits = [];
    for (const sym of held.slice(0, 6)) {
      const cik = byTicker[sym];
      if (!cik) continue;
      try {
        const d = await (await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: UA })).json();
        const r = d?.filings?.recent;
        if (!r) continue;
        for (let i = 0; i < Math.min(r.form.length, 25); i++) {
          if (r.filingDate[i] >= cutoff && ["8-K", "10-Q", "10-K", "4"].includes(r.form[i])) {
            hits.push(`${sym}: ${r.form[i]} filed ${r.filingDate[i]}${r.primaryDocDescription?.[i] ? ` (${r.primaryDocDescription[i]})` : ""}`);
          }
        }
      } catch (e) { console.warn(`EDGAR ${sym} failed:`, e.message); }
    }
    filingsBrief = hits.slice(0, 8).join("; ");
    if (filingsBrief) console.log("Filings brief:", filingsBrief);
  } catch (e) { console.warn("EDGAR ticker map failed:", e.message); }
}

let econBrief = "";
/** Upcoming major economic releases (CPI, jobs, GDP, PCE, retail, PPI)
 *  from FRED's release calendar — so the committee knows when the
 *  market-moving prints land, the way it already knows earnings dates. */
async function gatherEconCalendar() {
  if (!FRED) return;
  try {
    const to = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const u = `https://api.stlouisfed.org/fred/releases/dates?api_key=${FRED}&file_type=json` +
              `&realtime_start=${todayISO}&realtime_end=${to}&include_release_dates_with_no_data=true&sort_order=asc&limit=200`;
    const d = await (await fetch(u)).json();
    const KEY = ["Consumer Price Index", "Employment Situation", "Gross Domestic Product",
                 "Personal Income and Outlays", "Producer Price Index", "Retail"];
    const hits = (d?.release_dates || [])
      .filter((r) => r.date >= todayISO && KEY.some((k) => (r.release_name || "").includes(k)))
      .map((r) => `${r.release_name} on ${r.date}`);
    econBrief = [...new Set(hits)].slice(0, 8).join("; ");
    if (econBrief) console.log("Econ calendar:", econBrief);
  } catch (e) { console.warn("FRED release calendar failed:", e.message); }
}

/* ----------------------- pre-market game plan --------------- */
/**
 * Runs once before the open (~13:00 UTC): no trading, just reading.
 * The committee digests overnight news, filings, and the calendars,
 * and writes a game plan that every trading cycle that day inherits.
 */
async function preMarketPrep() {
  const r = await askCommittee(committeeContext() +
    `\n\nPre-market preparation (no trading now). Using web search plus the briefs above, digest overnight developments and write today's game plan: what to watch, what would change your mind on current positions, which watchlist names look most interesting and why, and any events today that call for caution.
JSON schema: {"gamePlan":"4-6 plain sentences"}`);
  if (r?.gamePlan) {
    state.gamePlan = { date: todayISO, text: r.gamePlan };
    await notify(`🌅 Pre-market game plan: ${r.gamePlan}`);
  }
}

async function gatherEarnings() {
  if (!FINNHUB) return;
  try {
    const to = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const d = await (await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${todayISO}&to=${to}&token=${FINNHUB}`)).json();
    const universe = new Set([...state.positions.map((p) => p.ticker), ...config.watchlist]);
    const hits = (d?.earningsCalendar || [])
      .filter((e) => universe.has(e.symbol))
      .map((e) => `${e.symbol} reports ${e.date}${e.hour ? ` (${e.hour})` : ""}`);
    earningsBrief = [...new Set(hits)].slice(0, 10).join("; ");
    if (earningsBrief) console.log("Earnings brief:", earningsBrief);
  } catch (e) { console.warn("Finnhub earnings calendar failed:", e.message); }
}

/* ----------------------- weekly self-review ---------------- */
/**
 * Every Friday after the close, the committee rereads its own
 * ledger and writes a short "lessons" note. The last few notes
 * are injected into every future briefing — the system's memory
 * of what worked, what didn't, and what it keeps getting wrong.
 */
async function weeklyReview() {
  const weekAgo = Date.now() - 7 * 864e5;
  const rows = state.ledger.filter((t) => new Date(t.time).getTime() >= weekAgo);
  const summary = rows.map((t) => `${t.status} ${t.action} ${t.shares} ${t.ticker} @ ${t.price} (conf ${t.confidence ?? "-"}%): ${t.thesis}`).join("\n") || "no decisions this week";
  const posNow = state.positions.map((p) => `${p.ticker} ${(((p.price - p.entry) / p.entry) * 100).toFixed(1)}%`).join(", ") || "flat";
  const r = await askCommittee(committeeContext() +
    `\n\nWeekly self-review. This week's ledger:\n${summary}\nOpen positions P/L now: ${posNow}.
Critique your own decisions honestly: what worked, what didn't, patterns to correct (oversizing, chasing news, ignoring earnings dates, etc). Be specific and self-critical, not congratulatory.
JSON schema: {"lessons":"3-5 plain sentences of concrete lessons for next week"}`, 1000);
  if (r?.lessons) {
    state.lessons = [{ week: todayISO, text: r.lessons }, ...(state.lessons || [])].slice(0, 4);
    await notify(`🧭 Weekly self-review: ${r.lessons}`);
  }
}

/** Shared context the committee receives on every request. */
function committeeContext() {
  const pos = state.positions.map((p) =>
    `${p.ticker}: ${p.shares} sh, entry ${p.entry.toFixed(2)}, last ${p.price.toFixed(2)} (${p.sector})`).join("; ") || "none";
  return `You are the autonomous investment committee of a paper-trading system mirroring a "How The Market Works" simulator account (no real money). Now: ${now.toUTCString()}.
Operating mode: ${mode.label}. Mandate: ${mode.tone} Aspirational target: ${mode.target}. Circuit breaker at -${mode.breaker * 100}% cumulative drawdown (currently ${(drawdown() * 100).toFixed(1)}%).
Portfolio: total ${usd(totalValue())}, cash ${usd(state.cash)}. Positions: ${pos}.
Hard constraints enforced in code: max position ${config.maxPositionPct}% of book, cash reserve ${config.cashReservePct}%, max ${config.maxDailyTrades} trades/day (${tradesToday()} used today).
Doctrine: never decide from one indicator; weigh technicals, fundamentals, macro, geopolitics, sentiment, and historical analogues. Protect capital before seeking returns. HOLD/AVOID are valid outcomes. During extraordinary market-wide shocks, do not panic-sell if historical evidence favors recovery; assess cause, severity, and recovery odds first. Explain in plain English.${
  newsBrief.length
    ? "\nLive news wire (deduplicated from Marketaux/Finnhub; sentiment is -1..1 where provided — treat it as one input, not truth):\n" +
      newsBrief.map((n) => `- [${n.sym}] ${n.head}${n.sent != null ? ` (sent ${n.sent})` : ""}`).join("\n")
    : ""
}${techBrief ? `\nComputed technicals (measured locally from daily closes — use these numbers rather than estimating; note they can lag intraday moves):\n${techBrief}` : ""}${macroBrief ? `\nMacro wire (FRED, primary-source): ${macroBrief}` : ""}${
  filingsBrief ? `\nFresh SEC filings on holdings (last 3 days — 8-Ks are material events, weigh them): ${filingsBrief}` : ""
}${earningsBrief ? `\nEarnings in the next 7 days (earnings are high-variance — be cautious opening or holding oversized positions into them, especially in Conservative mode): ${earningsBrief}` : ""}${
  econBrief ? `\nEconomic releases ahead (major prints move the whole market — factor timing into sizing): ${econBrief}` : ""
}${
  state.gamePlan && state.gamePlan.date === todayISO
    ? `\nToday's pre-market game plan (follow it unless conditions have clearly changed): ${state.gamePlan.text}`
    : ""
}${
  (state.lessons || []).length
    ? `\nYour own lessons from recent weekly self-reviews (apply them):\n` + state.lessons.map((l) => `- [${l.week}] ${l.text}`).join("\n")
    : ""
}`;
}

/* ----------------------- notifications --------------------- */
/**
 * Push alerts to a webhook. Auto-detects the service from the URL:
 *  - Discord webhooks (discord.com/api/webhooks/...) → {content}
 *  - Google Chat space webhooks (chat.googleapis.com/...) → {text}
 *    (note: Google Chat webhooks require a Workspace account)
 * Same secret either way: DISCORD_WEBHOOK.
 */
async function notify(msg) {
  console.log("NOTIFY:", msg);
  // Always record to the dashboard's Updates feed — this is the primary
  // notification channel. The dashboard shows everything since your last visit.
  state.events = [{ t: new Date().toISOString(), msg }, ...(state.events || [])].slice(0, 60);
  if (!DISCORD) return;
  try {
    const isGoogleChat = DISCORD.includes("chat.googleapis.com");
    await fetch(DISCORD, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(isGoogleChat ? { text: msg.slice(0, 3900) } : { content: msg.slice(0, 1900) }),
    });
  } catch (e) { console.warn("webhook notify failed:", e.message); }
}

/* ----------------------- step 1: mark to market ------------ */
async function markToMarket() {
  const updated = new Set();
  if (state.positions.length && CAN_SEARCH) {
    try {
      const syms = state.positions.map((p) => p.ticker).join(", ");
      const out = await askCommittee(
        `Find the most recent US trading price for: ${syms}. JSON schema: {"prices":{"TICKER":123.45}}`, 800);
      for (const p of state.positions) {
        const px = Number(out?.prices?.[p.ticker]);
        if (px > 0) { p.price = px; updated.add(p.ticker); }
      }
    } catch (e) { console.warn("AI price sync failed:", e.message); }
  }
  // Fallback (and the primary path in no-search mode): any symbol the AI
  // didn't price gets its last Stooq daily close, so the breaker math
  // never runs on stale prices when data exists.
  for (const p of state.positions) {
    if (!updated.has(p.ticker) && stooqClose[p.ticker] > 0) p.price = stooqClose[p.ticker];
  }
  // Append one equity-curve point per day (keep ~1 year).
  state.history = (state.history || []).filter((h) => h.t !== todayISO);
  state.history.push({ t: todayISO, v: +totalValue().toFixed(2) });
  state.history = state.history.slice(-260);
  // Benchmark: record SPY's close so the dashboard can answer the only
  // question that ultimately matters — are we beating the index?
  if (stooqClose["SPY"] > 0) {
    state.benchmark = (state.benchmark || []).filter((h) => h.t !== todayISO);
    state.benchmark.push({ t: todayISO, v: stooqClose["SPY"] });
    state.benchmark = state.benchmark.slice(-260);
  }
}

/* ----------------------- step 2: decision cycle ------------ */
async function decisionCycle() {
  const tripped = drawdown() >= mode.breaker;

  // Circuit breaker: code-level enforcement the AI cannot override.
  if (tripped && !state.breakerAcknowledged) {
    state.breakerTripped = true;
    await notify(`🔴 CIRCUIT BREAKER: drawdown ${(drawdown() * 100).toFixed(1)}% hit the ${mode.label} limit of ${mode.breaker * 100}%. New positions suspended; risk-reduction only. Set "breakerAcknowledged": true in docs/data/state.json to resume.`);
  }
  const sellOnly = tripped;

  if (!sellOnly && tradesToday() >= config.maxDailyTrades) {
    console.log("Daily trade limit reached; research-only cycle.");
  }

  // --- Mandatory position review (code-enforced discipline) ---
  // Any position beyond the loss/gain thresholds is forced onto the
  // agenda once per day: the committee MUST reassess it before it may
  // think about anything else. A drifting loser can't be ignored in
  // favor of something shinier.
  if (state.reviewedToday && Object.keys(state.reviewedToday).length) {
    for (const k of Object.keys(state.reviewedToday)) {
      if (state.reviewedToday[k] !== todayISO) delete state.reviewedToday[k];
    }
  } else state.reviewedToday = {};
  const flagged = state.positions.find((p) => {
    const pl = (p.price - p.entry) / p.entry;
    return state.reviewedToday[p.ticker] !== todayISO &&
      (pl <= -(config.reviewLossPct ?? 8) / 100 || pl >= (config.reviewGainPct ?? 20) / 100);
  });

  // --- Watchlist rotation: every name gets a dedicated look ---
  const rot = config.watchlist.length
    ? config.watchlist[(state.rotationIndex ?? 0) % config.watchlist.length]
    : null;

  let ask;
  if (flagged) {
    const pl = ((flagged.price - flagged.entry) / flagged.entry * 100).toFixed(1);
    state.reviewedToday[flagged.ticker] = todayISO;
    ask = `MANDATORY POSITION REVIEW: ${flagged.ticker} (${flagged.shares} sh, entry ${flagged.entry.toFixed(2)}) is ${pl}% from entry, beyond the review threshold. Using live web search plus the briefs above, reassess this position now. Your action must concern ${flagged.ticker}: SELL (full or partial, set suggestedShares) or HOLD with a clearly renewed thesis. Do not evaluate anything else this cycle.${sellOnly ? " The circuit breaker is active: only SELL or HOLD are permitted." : ""}`;
  } else if (sellOnly) {
    ask = `The circuit breaker is ACTIVE. You may only recommend SELL (risk reduction on existing positions) or HOLD. Evaluate current holdings with live web search and decide.`;
  } else {
    state.rotationIndex = ((state.rotationIndex ?? 0) + 1) % Math.max(1, config.watchlist.length);
    ask = `Using live web search on today's market, evaluate the watchlist (${config.watchlist.join(", ")}) and current holdings${config.preferredSectors ? `, preferring sectors: ${config.preferredSectors}` : ""}. Scheduled rotation: give ${rot} a dedicated, full-evidence look this cycle — then still recommend the single best action overall, which may or may not involve ${rot}. HOLD is valid if nothing clears the evidence bar.`;
  }

  const schema = `JSON schema:
{"ticker":"","action":"BUY|SELL|HOLD|AVOID","currentPrice":0,"sector":"","confidence":0,"risk":"Low|Moderate|High|Very High","expectedReward":"","expectedDownside":"","holdingPeriod":"","suggestedShares":0,"thesis":"2-3 plain sentences","evidence":{"technical":"","fundamental":"","macro":"","geopolitical":"","sentiment":"","historical":""},"risks":[""],"alternativesConsidered":[{"option":"","whyRejected":""}],"news":[""],"marketRegime":"normal|stressed|emergency","regimeNote":""}
suggestedShares must fit the position-size and cash-reserve constraints at currentPrice.`;

  const memo = await askCommittee(committeeContext() + "\n\n" + ask + "\n" + schema);
  memo.timestamp = now.toISOString();
  state.latestMemo = memo;

  // Emergency Market Protocol: flag it, reduce nothing automatically
  // beyond what the memo recommends, and always explain.
  if (memo.marketRegime === "emergency" || memo.marketRegime === "stressed") {
    await notify(`⚠️ Market regime "${memo.marketRegime}": ${memo.regimeNote || memo.thesis}`);
  }

  execute(memo, sellOnly);
}

/* ----------------------- step 3: enforce & execute --------- */
function execute(memo, sellOnly) {
  const shares = Math.max(0, Math.floor(Number(memo.suggestedShares) || 0));
  const price  = Number(memo.currentPrice) || 0;
  const total  = totalValue();

  const reject = (why) => {
    console.log(`Decision not executed: ${why}`);
    state.ledger.unshift(logRow(memo, 0, price, "SKIPPED — " + why));
    state.ledger = state.ledger.slice(0, 500);
  };

  if (memo.action === "HOLD" || memo.action === "AVOID") {
    console.log(`Committee says ${memo.action}: ${memo.thesis}`);
    return; // nothing to do — a valid, disciplined outcome
  }
  if (!shares || !price) return reject("memo lacked usable size or price");

  if (memo.action === "BUY") {
    if (sellOnly)                                   return reject("circuit breaker active — buys suspended");
    if (tradesToday() >= config.maxDailyTrades)     return reject("daily trade limit reached");
    if (Number(memo.confidence) < config.minConfidenceToTrade)
                                                    return reject(`conviction ${memo.confidence}% below floor ${config.minConfidenceToTrade}%`);
    const cost = shares * price;
    if (cost > (config.maxPositionPct / 100) * total) return reject("exceeds max position size");
    if (cost > state.cash - (config.cashReservePct / 100) * total)
                                                    return reject("would breach cash reserve");
    const ex = state.positions.find((p) => p.ticker === memo.ticker);
    if (ex) {
      ex.entry = (ex.entry * ex.shares + price * shares) / (ex.shares + shares);
      ex.shares += shares; ex.price = price;
    } else {
      state.positions.push({ ticker: memo.ticker, shares, entry: price, price, sector: memo.sector || "Other" });
    }
    state.cash -= cost;
    state.ledger.unshift(logRow(memo, shares, price, "EXECUTED"));
    notify(`🟢 BUY ${shares} ${memo.ticker} @ ${usd(price)} (${memo.confidence}% conviction, ${memo.risk} risk)\n${memo.thesis}`);
  }

  if (memo.action === "SELL") {
    const pos = state.positions.find((p) => p.ticker === memo.ticker);
    if (!pos) return reject(`no open position in ${memo.ticker}`);
    const qty = Math.min(shares, pos.shares);
    pos.shares -= qty; pos.price = price;
    state.cash += qty * price;
    state.positions = state.positions.filter((p) => p.shares > 0);
    state.ledger.unshift(logRow({ ...memo, suggestedShares: qty }, qty, price, "EXECUTED"));
    notify(`🔻 SELL ${qty} ${memo.ticker} @ ${usd(price)}\n${memo.thesis}`);
  }
  state.ledger = state.ledger.slice(0, 500);
}

/** A permanent, self-explaining ledger row. */
function logRow(memo, shares, price, status) {
  return {
    time: now.toISOString(), status, ticker: memo.ticker, action: memo.action,
    shares, price, confidence: memo.confidence ?? null, risk: memo.risk ?? null,
    mode: mode.label, regime: memo.marketRegime ?? "normal",
    thesis: memo.thesis || "", evidence: memo.evidence || null,
  };
}

/* ----------------------- daily report ---------------------- */
async function dailyReport() {
  const recent = state.ledger.slice(0, 6).map((t) => `${t.status} ${t.action} ${t.shares} ${t.ticker} @ ${t.price}`).join("; ") || "none";
  const r = await askCommittee(committeeContext() +
    `\n\nFile today's end-of-day report using live web search. Recent ledger: ${recent}.
JSON schema: {"date":"","marketSummary":"","majorNews":[""],"economicEvents":"","fedUpdate":"","geopolitics":"","stocksWatched":[""],"tradesComment":"","riskAssessment":"","planForTomorrow":""}`);
  r.date = r.date || todayISO;
  r.timestamp = now.toISOString();
  state.reports = [r, ...(state.reports || [])].slice(0, 40);
  await notify(`📄 Daily report filed for ${r.date}: ${r.marketSummary}`);
}

/* ----------------------- main ------------------------------ */
try {
  const isReportRun = now.getUTCHours() >= 21 || process.env.RUN_MODE === "report";
  const isPrepRun = process.env.RUN_MODE === "prep" ||
    (now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && now.getUTCHours() === 13 && now.getUTCMinutes() < 25);
  if (isPrepRun) {
    await Promise.all([
      gatherNews().catch((e) => console.warn("news gather failed:", e.message)),
      gatherTechnicals().catch((e) => console.warn("technicals failed:", e.message)),
      gatherMacro().catch((e) => console.warn("macro gather failed:", e.message)),
      gatherFilings().catch((e) => console.warn("filings gather failed:", e.message)),
      gatherEarnings().catch((e) => console.warn("earnings gather failed:", e.message)),
      gatherEconCalendar().catch((e) => console.warn("econ calendar failed:", e.message)),
    ]);
    await preMarketPrep();
  } else if (isReportRun) {
    await Promise.all([
      gatherNews().catch((e) => console.warn("news gather failed:", e.message)),
      gatherTechnicals().catch((e) => console.warn("technicals failed:", e.message)),
      gatherMacro().catch((e) => console.warn("macro gather failed:", e.message)),
      gatherFilings().catch((e) => console.warn("filings gather failed:", e.message)),
      gatherEarnings().catch((e) => console.warn("earnings gather failed:", e.message)),
      gatherEconCalendar().catch((e) => console.warn("econ calendar failed:", e.message)),
    ]);
    await markToMarket().catch((e) => console.warn("mark-to-market failed:", e.message));
    await dailyReport();
    // Friday: the committee critiques its own week and records lessons.
    if (now.getUTCDay() === 5) {
      await weeklyReview().catch((e) => console.warn("weekly review failed:", e.message));
    }
  } else if (marketLikelyOpen() || process.env.RUN_MODE === "force") {
    await Promise.all([
      gatherNews().catch((e) => console.warn("news gather failed:", e.message)),
      gatherTechnicals().catch((e) => console.warn("technicals failed:", e.message)),
      gatherMacro().catch((e) => console.warn("macro gather failed:", e.message)),
      gatherFilings().catch((e) => console.warn("filings gather failed:", e.message)),
      gatherEarnings().catch((e) => console.warn("earnings gather failed:", e.message)),
      gatherEconCalendar().catch((e) => console.warn("econ calendar failed:", e.message)),
    ]);
    await markToMarket().catch((e) => console.warn("mark-to-market failed:", e.message));
    await decisionCycle();
  } else {
    console.log("Market closed — skipping cycle.");
  }
  save();
  console.log(`Done. Book: ${usd(totalValue())} | cash ${usd(state.cash)} | drawdown ${(drawdown() * 100).toFixed(1)}%`);
} catch (err) {
  console.error("Agent cycle failed:", err);
  save(); // persist whatever progressed (e.g. price marks)
  process.exit(1);
}
