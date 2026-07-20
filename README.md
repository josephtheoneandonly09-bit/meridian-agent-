# Meridian & Co. — Autonomous AI Investment Agent (Paper Beta)

A fully autonomous paper-trading agent that runs on GitHub Actions — free, no server.
Every 30 minutes during US market hours it researches the market with live web search
(Claude API), makes one disciplined decision, enforces your risk rules in code, executes
in its paper portfolio, and commits the result back to this repo. A dashboard on GitHub
Pages shows the book, every decision memo, the ledger, and daily reports.

It mirrors a **How The Market Works** simulator account: no real money, and you mirror
its fills in HTMW yourself if you want the two in sync.

> **Honesty first:** this is an educational tool, not investment advice. The mode growth
> targets (15–35%/quarter) are aspirations from the design brief, not achievable promises.
> No system reliably earns those returns; expect drawdowns.

---

## Setup (10 minutes, one time)

1. **Create the repo.** Make a new GitHub repository (public is easiest — Pages and
   Actions are free) and upload everything in this folder, keeping the structure:
   `agent/`, `docs/`, `.github/workflows/`, `config.json`.

2. **Add your AI key.** The agent has a hybrid brain — set by `"provider"` in
   `config.json` (currently `"gemini"`, the free option):
   - **Gemini (free, no card ever):** go to https://aistudio.google.com/apikey,
     sign in with any Google account, click **Create API key**, copy it. Add it in
     the repo under *Settings → Secrets and variables → Actions → New repository
     secret* as `GEMINI_API_KEY`. Research runs on Google Search grounding. Free-tier
     daily limits comfortably cover the 15-minute cadence, but a heavily throttled
     day could occasionally skip a cycle — acceptable for paper trading.
   - **Groq (free, no card, easiest signup):** go to https://console.groq.com,
     sign in with your Google *or GitHub* account, then API Keys → Create API Key.
     Add it as `GROQ_API_KEY`. Groq has no live web search, so the agent runs in
     feed-driven mode: the two news wires, FRED macro data, SEC filings, calendars,
     and computed technicals carry the current-events load, and prices come from
     daily-close data. Analysis is the plainest of the three brains, but the risk
     rules are identical.
   - **Claude (paid, stronger analysis):** get a key at https://console.anthropic.com
     (billing required, ~$2–6/trading day) and add it as `ANTHROPIC_API_KEY`. To
     upgrade later, add that secret and change `"provider"` to `"anthropic"` in
     `config.json` — one commit, nothing else changes. If the configured provider's
     key is missing, the agent automatically falls back to whichever key exists.
   - *(Optional)* add `DISCORD_WEBHOOK` with a Discord channel webhook URL to get
     pinged on every trade, breaker event, and daily report.
   - *(Optional, recommended — both free)* add news-wire keys so the committee reads
     a guaranteed-fresh headline brief every cycle instead of relying on web search
     alone. Either or both work; they're merged and deduplicated:
     - `MARKETAUX_API_KEY` — free key at https://www.marketaux.com (no card required);
       adds multi-source headlines with per-article sentiment scores.
     - `FINNHUB_API_KEY` — free key at https://finnhub.io; adds fast general-market
       and company-specific headlines for your holdings, plus the earnings calendar
       (the committee is warned when a holding reports within 7 days).
     - `FRED_API_KEY` — free key at https://fred.stlouisfed.org/docs/api/api_key.html
       (instant, no card); adds a primary-source macro wire every cycle: Fed funds
       rate, CPI inflation, unemployment, the 10y–2y yield curve, and the VIX close.
   - **SEC EDGAR filings need no key at all** — the agent automatically checks each
     holding for fresh 8-K / 10-Q / 10-K / insider (Form 4) filings from the last
     3 days and puts them in front of the committee.
   - **Computed technicals need no key either** — every cycle the agent downloads
     free daily price history (Stooq) for the watchlist and holdings and computes
     real numbers locally: trend vs the 50-day and 200-day averages, RSI-14, ATR
     volatility, distance from the 52-week high, and 20-day return. The committee
     reasons from measured data instead of estimates, and these closes also serve
     as a pricing fallback so the circuit-breaker math never runs on stale numbers.

3. **Enable the dashboard.** Repo → *Settings → Pages* → Source: *Deploy from a branch* →
   Branch: `main`, folder: `/docs`. Your dashboard will live at
   `https://<your-username>.github.io/<repo-name>/`.

4. **First run.** Repo → *Actions* → enable workflows → open **Meridian Agent** →
   *Run workflow* (run_mode: `force`). Watch the log; when it finishes, refresh the
   dashboard.

That's it. The schedule takes over from there.

## How it behaves

- **Cycles:** every ~30 min, 13:30–20:00 UTC, Mon–Fri (≈ 9:30–4 ET in summer; GitHub
  cron is UTC, so it shifts one hour in winter — adjust `.github/workflows/agent.yml`
  if you care). GitHub's scheduler is best-effort; runs can land a few minutes late.
- **Each cycle:** mark to market → check circuit breaker → one researched decision
  (BUY / SELL / HOLD / AVOID) with evidence across technicals, fundamentals, macro,
  geopolitics, sentiment, and historical analogues → code-level rule checks → execute
  → commit state.
- **Risk rules are code, not AI.** Max position size, cash reserve, daily trade cap,
  and the conviction floor are enforced by the agent script. The AI cannot override
  them. Skipped decisions are logged with the reason.
- **Circuit breaker:** at the mode's drawdown limit (Conservative −20% / Liberal −35% /
  Aggressive −50%), buying stops automatically; only risk-reduction sells are allowed.
  To resume, edit `docs/data/state.json` and set `"breakerAcknowledged": true`.
- **Emergency protocol:** the committee tags each cycle `normal | stressed | emergency`.
  In shocks it is instructed to assess cause, severity, and recovery odds — and not to
  panic-sell when history favors recovery. Regime changes trigger a notification.
- **Daily report:** files automatically after the close (~21:10 UTC) and appears on the
  dashboard.
- **Weekly self-review:** every Friday after the close, the committee critiques its own
  week — what worked, what didn't, patterns to correct — and records the lessons. The
  last four weeks of lessons are injected into every future briefing, so the system
  carries its own memory of mistakes forward.
- **Benchmark honesty:** the dashboard tracks your portfolio against the S&P 500 (SPY)
  from day one — a "You vs S&P 500" card and a grey index line on the equity curve.
  If the committee isn't beating the boring alternative, you'll see it plainly.
- **Mandatory position reviews:** if any position moves beyond the thresholds in
  `config.json` (default −8% or +20% from entry), code forces it onto the committee's
  agenda that cycle — it must reassess that position (SELL or renewed-thesis HOLD)
  before thinking about anything else. Once per position per day.
- **Watchlist rotation:** each cycle spotlights the next watchlist name in turn, so
  every symbol gets a dedicated full-evidence look at least daily — quiet names can't
  be ignored in favor of whatever's loudest.
- **Pre-market prep:** at ~13:00 UTC each weekday, a no-trading run digests overnight
  news, filings, and the calendars, and writes the day's game plan. Every trading
  cycle that day inherits it (and it shows on the dashboard).
- **Economic release calendar:** with a FRED key, the committee is told when CPI,
  jobs, GDP, PCE, PPI, and retail-sales prints land in the next 7 days, so sizing
  can respect big macro dates the way it already respects earnings dates.

## Tuning (`config.json`)

| Key | Meaning |
|---|---|
| `mode` | `conservative` / `liberal` / `aggressive` |
| `startingValue` | Match your HTMW account (default 100000) |
| `maxPositionPct` | Max % of the book in one name |
| `maxDailyTrades` | Hard daily trade cap |
| `cashReservePct` | Cash floor the agent may never spend below |
| `minConfidenceToTrade` | Conviction floor for buys (e.g. 65) |
| `watchlist` | Tickers the committee scans each cycle |

Commit a change to `config.json` and the next cycle uses it.

## Costs

- **On Gemini or Groq: $0.** Both free tiers require no payment method.
- **On Claude:** roughly 2 search-grounded calls per cycle × ~27 cycles/day ≈
  **$2–6 per trading day** at Sonnet pricing. To cut it, change the cron to every
  30 min (`0,30 14-19 * * 1-5`, ~half) or hourly (`0 14-19 * * 1-5`, ~quarter).

## Resetting

Restore `docs/data/state.json` to its original contents (cash = startingValue, empty
arrays) and commit.
