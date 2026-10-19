# AlgoDesk India — Algo Trading Terminal 🇮🇳

Indian market (NSE · BSE · NFO · MCX · CDS) mate algo trading software:

- **⭐ Watchlist** — India Top Momentum Stocks Scanner (TRENT, BEL, HAL, ZOMATO, DIXON, SUZLON, વગેરે) + Live Option Chain strikes જરૂર મુજબ add/track કરો
- **Stock Finder** — badha segments, filters, top gainers/losers
- **Options Chain** — Delta (Δ), Gamma, Theta, Vega, IV, OI, PCR, Max Pain
- **Strategy Builder** — 15 templates (Straddle, Iron Condor, Spreads …), payoff chart
- **Algo Setups** — Manual / Auto entry–exit, Stop Loss, Target, Trailing SL, Edit anytime
- **Capital & Risk** — ₹10,000 default, risk per trade, daily loss limit, capital guard
- **◎ Indicator Signals** — Supertrend · EMA 9/21 · MACD · RSI · ADX · Bollinger · Stochastic · VWAP · Volume → ek **BUY / SELL / HOLD** call, score, ATR-based SL/Target, 1-click setup
- **Excel report** — badhu **ek j sheet** ma (Capital, Signals, Positions, Strategies, Orders, Margin), auto-update every N minutes
- **Market data** — Yahoo Finance quotes (~15 min delayed), simulator fallback
- **Brokers (12)** — Dhan · Angel One · Zerodha Kite · Upstox · Fyers · Shoonya · Flattrade · Alice Blue · 5paisa · ICICI Breeze · Kotak Neo · Delta Exchange (crypto) — Paper / Live
- **₿ Crypto (Delta Exchange India)** — BTC/ETH + 13 perpetuals 24×7, real option chain (live premium/OI/IV/Greeks), public live WebSocket (API key fakt orders mate), paper + live orders
- **⚡ 0-delay live data** — Dhan / Angel One WebSocket tick-by-tick feed, browser streaming (SSE), instant tick-driven SL/Target
- **🛡 Admin panel** — username + password login, 2FA (Google Authenticator), roles (admin/trader/viewer), sessions, lockout, audit log, encrypted broker keys

> ⚠️ **Hamesha pehla Paper mode ma test karo.** Live mode ma real orders broker ne jay chhe. Trading ma nuksan (loss) nu jokham chhe.

---

## 📋 Requirements (jaruriyat)

| Item | Version |
|---|---|
| OS | Windows 10/11 · macOS 12+ · Ubuntu 22.04+ |
| Node.js | **22 LTS** (minimum 20.9) |
| PostgreSQL | 14+ (**16 recommended**) — athva Docker |
| RAM / Disk | 2 GB+ RAM · 1 GB free disk |
| Internet | Yahoo Finance quotes + broker APIs mate |

✅ **Database auto-setup:** app pehli vaar start thay tyare `app_db` database, badha tables ane nava columns **aapmele** bane chhe. Koi SQL / migration command chalavvani jarur nathi.

---

## 🪟 Option 1 — Windows PC (Recommended)

1. **Node.js 22 LTS** install karo → <https://nodejs.org/en/download> → LTS → Next → Install  
   Check: Command Prompt ma `node -v`
2. **PostgreSQL 16** install karo → <https://www.postgresql.org/download/windows/>
   - Password: **`postgres`**
   - Port: **`5432`**
   - Stack Builder skip karo (`app_db` app pote banavshe)
3. **Project files** → tamne malel zip / folder ne `C:\AlgoDesk` ma Extract karo
   > App ni andar thi source download karvanu feature **jaanine kadhi nakhel chhe** (app ni copy na thay te mate). Aa project folder no backup tamare jaate rakhvo.
4. **Setup** → `C:\AlgoDesk\scripts\setup-windows.bat` upar **double-click**  
   → packages install → build → browser ma <http://localhost:3000> khulshe  
   (black window chalu rakho — bandh karsho to app bandh thashe)
5. **Roj start** → `scripts\start-windows.bat` double-click

Manual commands (Command Prompt):

```bat
cd C:\AlgoDesk
copy .env.example .env
npm install
npm run build
npm start
```

---

## 🐳 Option 2 — Docker (Windows / Mac / Linux, sauthi saral)

1. Docker Desktop install karo → <https://www.docker.com/products/docker-desktop/>
2. Zip extract karo, te folder ma terminal kholo:

```bash
docker compose up -d --build     # App + PostgreSQL start
```

3. Browser → <http://localhost:3000>

```bash
docker compose logs -f app       # logs
docker compose down              # stop (data volume ma safe)
docker compose up -d --build     # update / restart
```

Admin: `docker compose logs app` ma **FIRST-RUN SETUP CODE** juo → `/login` par admin banavo. Encryption key: te j folder ma `.env` ma `APP_SECRET=<openssl rand -hex 32>` lakho, pachhi `docker compose up -d`.

---

## 🐧 Option 3 — Linux / macOS

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql unzip
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"

# macOS (Homebrew)
# brew install node@22 postgresql@16 && brew services start postgresql@16
# createuser -s postgres && psql -d postgres -c "ALTER USER postgres PASSWORD 'postgres';"

unzip algodesk-india-*.zip && cd algodesk-india
bash scripts/setup.sh            # .env + npm ci + build + start
```

Pachhi thi: `npm start` (biju port: `PORT=3001 npm start`)

---

## ☁ Option 4 — VPS 24×7 (Live algo mate)

Ubuntu 24.04 VPS (AWS Lightsail / DigitalOcean / Hostinger — **Mumbai region**, 2 GB RAM). VPS ma **static IP** male chhe je broker API whitelist mate jaruri chhe.

```bash
sudo timedatectl set-timezone Asia/Kolkata
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql unzip
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'StrongDbPass123';"

unzip algodesk-india-*.zip && cd algodesk-india
cp .env.example .env
nano .env
#   DATABASE_URL=postgresql://postgres:StrongDbPass123@127.0.0.1:5432/app_db
#   APP_SECRET=...   (node scripts/admin-cli.mjs init-env banave chhe)
#   ADMIN_USERNAME=owner  ADMIN_PASSWORD=Very#Strong2026   (login pachhi kadhi nakho)

npm ci && npm run build
sudo npm i -g pm2
pm2 start npm --name algodesk -- start
pm2 save && pm2 startup                         # reboot pachhi auto start

sudo ufw allow OpenSSH && sudo ufw allow 3000/tcp && sudo ufw enable
```

Open `http://SERVER_IP:3000` → admin login → **turant 2FA chalu karo**. VPS par HTTPS (nginx + certbot / Cloudflare) jaruri.

---

## 🚀 First-run checklist (install pachhi)

1. **Admin & Security → Security Checklist** ma badha checks ✓ chhe te juo
2. **Dashboard → Capital & Risk → Edit** → capital (₹10,000), risk %, daily loss %
3. **Brokers** → Dhan / Angel One / Kotak Neo umero (**Paper mode**) → Login → Test
4. **Stock Finder / Options Chain / Strategy Builder** → setup banavo
5. Paper trade ENTER → EXIT → **Orders** ma check karo
6. Admin & Security → Security Checklist ma dekhato **Public IP** broker API portal ma **whitelist** karo (SEBI retail-algo niyam)
7. Badhu barabar hoy to j broker ne **LIVE** karo

---

## ⚙ Environment variables (`.env`)

| Variable | Required | Example | Kaam |
|---|---|---|---|
| `DATABASE_URL` | ✅ | `postgresql://postgres:postgres@127.0.0.1:5432/app_db` | PostgreSQL connection |
| `APP_SECRET` | ✅ (auto) | 64 hex chars | Broker keys / 2FA secrets AES-256-GCM encryption key — `node scripts/admin-cli.mjs init-env` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | optional | `owner` / `Very#Strong2026` | Pehlo admin aapmele banave (nahi to setup code) — login pachhi password kadhi nakho |
| `ALLOWED_ORIGINS` | optional | `https://algo.example.com` | Reverse proxy / custom domain mate extra CSRF-allowed origins |

> `PORT` `.env` ma kaam nathi kartu — command ma aapo: `PORT=3001 npm start` (Windows: `set PORT=3001 && npm start`).

---

## 🛡 Admin Panel & Strong Security (shu jaruri chhe?)

| Layer | AlgoDesk ma shu chhe |
|---|---|
| Login | Username + password (scrypt hash), generic error messages, constant-time compare |
| First admin | Default **admin / admin** — pehli login par strong password farajiyat badalvo pade chhe (athva `.env` ma `ADMIN_USERNAME/ADMIN_PASSWORD`) |
| Login OTP | Optional confirmation: **Gmail / Mobile SMS / Both** — My Account ma chalu karo (SMTP/SMS vagar OTP server console ma) |
| 2FA | TOTP (Google / Microsoft Authenticator, Authy) — QR scan, replay protection, admins mate farajiyat kari shakay |
| Brute force | 5 khota prayatno → 15 min lock · IP dith 10 attempts / 15 min |
| Sessions | httpOnly + SameSite cookie, idle 120 min / max 12 h, server-side revoke, "logout other devices" |
| Roles | **admin** (badhu) · **trader** (trade, broker login) · **viewer** (fakt jovu) — proxy ma har API par enforce |
| Secrets | Broker API key / token / MPIN / TOTP **AES-256-GCM encrypted**, browser ne kyarey pacha nathi mokalata |
| Web | CSP, X-Frame-Options (clickjacking), nosniff, HSTS (https), CSRF origin check |
| Audit | Login, failed login, lock, user changes, orders, broker/feed changes — Admin Panel → Audit Log (CSV) |

> nginx reverse proxy (HTTPS) ma aa headers jarur rakho, jethi Secure cookie + HSTS chalu thay:
> `proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` — SSE mate `proxy_buffering off;`

**Tamare karvanu:** (1) admin 2FA chalu karo (2) VPS par HTTPS (3) `APP_SECRET` backup (4) dar vyakti mate alag user (5) firewall: fakt 22 + 443 (6) roj DB backup.

```bash
# password bhuli gaya / locked out (server par)
node scripts/admin-cli.mjs reset-password admin "New#Strong2026"
node scripts/admin-cli.mjs unlock admin
node scripts/admin-cli.mjs disable-2fa admin        # phone khovai gayo
node scripts/admin-cli.mjs list
```

---

## ⚡ 0-Delay Live Market Data

```
Exchange → Broker WebSocket (binary ticks) → AlgoDesk Feed Hub → SSE stream → Browser (50 ms)
                                              └→ Tick Engine: SL / Target / Trailing / Entry turant
```

1. **Brokers** page par Dhan (Client ID + Access Token, Data API plan) athva Angel One (🔐 Login → JWT + feed token, free) umero
2. **Live Feed** page → broker select → **⚡ Start Live Feed** (auto-start on boot option)
3. **⟳ Sync** scrip master (roj ek vaar) → sacha securityId/symboltoken, real expiry & strikes, live option chain premium/OI/IV/Δ, LIVE orders mate token auto-fill
4. Feed bandh hoy to Yahoo (~15 min delay) → simulator fallback aapmele

Library: `src/lib/feed/` — `protocol.ts` (Dhan v2 + Angel SmartStream 2.0 binary parsers), `hub.ts` (single WebSocket, auto-reconnect, leases), `tokens.ts` (scrip master sync), `live.ts`, `/api/stream` (SSE), `useLiveTicks()` React hook.

> Physical network delay (exchange → broker → tamaro server) milliseconds ma rahe j. Kotak Neo feed hal supported nathi (orders chale chhe).

---

## ₿ Crypto — Delta Exchange India

- **Instruments:** BTCUSD, ETHUSD + 13 perpetuals (Stock Finder → segment CRYPTO / "₿ Crypto 24×7" preset)
- **Live data:** public WebSocket `socket.india.delta.exchange` — API key વગર પણ 0-delay ticks (Live Feed page ma "crypto" status)
- **Options Chain:** `BTCUSD` / `ETHUSD` select karo → **real strikes, expiries, premium, OI, IV, Greeks** sidha exchange thi (badhu USD ma)
- **Signals:** BTC/ETH par 10 indicators Delta candles thi (24×7)
- **Orders:** Brokers page → *Delta Exchange (Crypto)* → API Key + Secret (india.delta.exchange → Account → API Keys, trading permission + server IP whitelist). Paper mode pehla test karo!
- **Hisab:** 1 contract = `contract_value` coins (BTC 0.001, ETH 0.01). Margin ane P&L aapmele USD→INR convert thay chhe (USDINR rate entry vakhte sachvay chhe).
- ⚠️ Crypto prices **USD** ma chhe; क्रिप्टो trading par India ma 30% tax + 1% TDS lagu pade chhe — jaaṇīne trade karo.

---

## Indicator Signals (BUY / SELL / HOLD)

**Signals** page par watchlist na darek symbol mate 10 indicator chale chhe ane temna weighted vote thi **ek j call** male chhe:

| Indicator | Weight | Shu jue chhe |
|---|---|---|
| Supertrend (10,3) | 2.0 | Mukhya trend + fresh flip |
| EMA 9/21 cross | 2.0 | Golden / death cross |
| MACD (12,26,9) | 1.5 | Momentum histogram |
| RSI (14) | 1.5 | Oversold < 30 / Overbought > 70 |
| ADX (14) + DI | 1.0 | Trend majboot chhe ke range-bound |
| Bollinger (20,2) | 1.0 | Band touch / mid band |
| Stochastic (14,3) | 1.0 | %K vs %D crossover |
| VWAP (session) | 1.0 | Intraday buyers vs sellers |
| Price vs EMA 50 | 1.0 | Medium-term bias |
| Volume vs 20-avg | 0.5 | Move ne volume no support chhe? |

- **Score -100 … +100**: `>= +25` BUY · `<= -25` SELL · vachhe HOLD (indicators ek-matt nathi). `|score| >= 60` = STRONG.
- Timeframe: **5 min / 15 min / 1 hour / 1 day** · auto-refresh 30 sec
- Row kholo to darek indicator nu value, vote ane karan dekhay chhe + Support / Resistance / ATR
- **Buy / Sell** button dabavta setup aapmele bharai jay chhe — SL = 1.5x ATR, Target = 3x ATR (R:R 1:2)
- Candles Yahoo Finance parthi (live LTP chhelli candle ma lagade chhe); Yahoo na hoy to simulator

> Aa mechanical indicator summary chhe, **investment advice nathi**. HOLD etle edge nathi. Stop loss hamesha rakho.

---

## Excel Report — ek j sheet

Dashboard na **Excel Report** panel ma:

- **Download .xlsx** — ek j sheet "AlgoDesk" ma 6 section: Capital & P&L · Indicator Signals · Setups & Positions · Strategies · Order Book · Margin Allocation
- **Start Auto** — darek N minute e file fari banine update thay chhe (file nu naam hamesha `AlgoDesk-Report.xlsx`)
- **Save on server** — download na badle server par `exports/AlgoDesk-Report.xlsx` **te j file** overwrite thay chhe (24x7 VPS mate best)

---

## 🔄 Update · 💾 Backup · ♻ Restore

```bash
# Update: navi zip extract → juno .env copy karo → pachhi
npm ci && npm run build && npm start          # or: pm2 restart algodesk
# Database data safe rahe chhe; nava tables/columns aapmele umerai jay chhe.

# Backup
pg_dump -U postgres -h 127.0.0.1 app_db > algodesk-backup.sql
# Docker: docker exec algodesk-db pg_dump -U postgres app_db > algodesk-backup.sql

# Restore
psql -U postgres -h 127.0.0.1 -d app_db -f algodesk-backup.sql
```

---

## 🛠 Troubleshooting

| Error | Upay (Solution) |
|---|---|
| Admin password bhuli gaya / locked | `node scripts/admin-cli.mjs reset-password admin "New#Pass2026"` |
| Setup code kya chhe? | Server window / `pm2 logs` / `docker compose logs app` ma "FIRST-RUN SETUP CODE" |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL chalu nathi → Windows: `services.msc` → `postgresql-x64-16` → Start → Setup page → **Repair database** |
| `password authentication failed` | `.env` ma `DATABASE_URL` no password PostgreSQL password jevo rakho |
| `Port 3000 already in use` | `set PORT=3001 && npm start` (Windows) / `PORT=3001 npm start` |
| `npm.ps1 cannot be loaded` | Command Prompt (cmd) vapro athva `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Tables missing | Admin & Security → Security Checklist → **Repair database** |
| Yahoo feed "Fallback" | Internet / firewall check karo; app simulator thi chalu rahe chhe |
| Live order rejected (IP) | Public IP broker API portal ma whitelist karo |

---

## 📁 Project structure

```
src/app/            pages (Dashboard, Stocks, Options, Strategy, Setups, Orders, Brokers, Setup, Login)
src/app/api/        REST APIs (quotes, options-chain, setups, strategies, engine, export, system …)
src/lib/            market data (Yahoo), brokers, engine, capital, excel, strategies, db-init
src/db/schema.ts    Drizzle ORM schema
src/instrumentation.ts  auto database setup on server start
src/proxy.ts        security gate: sessions, roles, CSRF, headers, audit
scripts/            setup-windows.bat · start-windows.bat · setup.sh
docker-compose.yml  App + PostgreSQL
```

### Developer notes

- Dev server: `npm run dev`
- Schema badlo (`src/db/schema.ts`) pachhi: `npx drizzle-kit push` ane `src/lib/schema-sql.ts` regenerate karo (`npx drizzle-kit export`).
- Yahoo Finance public quotes ~15 min delayed hoy chhe. True real-time mate broker WebSocket feed jodvo.

---

**Disclaimer:** Aa software educational / personal use mate chhe. Koi investment advice nathi. Live trading tamara jokham par.
