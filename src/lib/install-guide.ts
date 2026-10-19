export type GuideStep = { title: string; body: string; cmd?: string; link?: { href: string; label: string } };
export type Guide = { id: string; label: string; icon: string; badge?: string; intro: string; steps: GuideStep[] };

export const REQUIREMENTS: { item: string; value: string }[] = [
  { item: "Operating system", value: "Windows 10/11 · macOS 12+ · Ubuntu 22.04+" },
  { item: "Node.js", value: "22 LTS (minimum 20.9)" },
  { item: "PostgreSQL", value: "14+ (16 recommended) — or Docker" },
  { item: "RAM / Disk", value: "2 GB+ RAM · 1 GB free disk" },
  { item: "Internet", value: "Yahoo Finance quotes + broker APIs" },
];

export const GUIDES: Guide[] = [
  {
    id: "windows",
    label: "Windows PC",
    icon: "🪟",
    badge: "Recommended",
    intro: "Windows 10/11 PC par 5 steps ma install. Database (app_db) ane badha tables pehli vaar start thata aapmele bani jay chhe — koi SQL lakhvani jarur nathi.",
    steps: [
      {
        title: "1. Node.js 22 LTS install karo",
        body: "nodejs.org parthi LTS installer download karo → Next → Next → Install (default options). Pachhi Command Prompt kholi version check karo.",
        cmd: "node -v\nnpm -v",
        link: { href: "https://nodejs.org/en/download", label: "nodejs.org" },
      },
      {
        title: "2. PostgreSQL 16 install karo",
        body: "Installer ma Password: postgres ane Port: 5432 rakho. Biju password rakho to .env file ma DATABASE_URL badalvo. Stack Builder skip karo. app_db database app pote banavshe.",
        link: { href: "https://www.postgresql.org/download/windows/", label: "postgresql.org" },
      },
      {
        title: "3. Project files extract karo",
        body: "Tamne malel project zip (athva folder) ne C:\\AlgoDesk ma Extract karo. Aa copy jaalvi rakho — app ma thi source download karvanu feature jaanine band karel chhe.",
      },
      {
        title: "4. Pehli vaar Setup chalavo",
        body: "C:\\AlgoDesk\\scripts\\setup-windows.bat upar double-click karo. Te .env banavshe, packages install karshe, build karshe ane browser ma http://localhost:3000 kholshe. Aa black window chalu rakho — bandh karsho to app bandh thashe.",
        cmd: "cd C:\\AlgoDesk\nscripts\\setup-windows.bat",
      },
      {
        title: "5. Roj start karo",
        body: "Pachhi darroj scripts\\start-windows.bat double-click karo (fari build ni jarur nathi). Market open thay te pehla start karo.",
        cmd: "scripts\\start-windows.bat",
      },
    ],
  },
  {
    id: "docker",
    label: "Docker",
    icon: "🐳",
    badge: "Easiest",
    intro: "Docker Desktop hoy to ek j command thi App + PostgreSQL banne chalu. Windows / Mac / Linux badhe same.",
    steps: [
      {
        title: "1. Docker Desktop install karo",
        body: "docker.com parthi Docker Desktop install karo ane chalu karo (whale icon green thay tya sudhi rah juo).",
        link: { href: "https://www.docker.com/products/docker-desktop/", label: "docker.com" },
      },
      {
        title: "2. Source code extract karo",
        body: "Project zip ne extract karo → te folder ma terminal / PowerShell kholo.",
        cmd: "cd algodesk-india",
      },
      {
        title: "3. Start karo",
        body: "Pehli vaar image build thashe (2-5 minute). Database data 'algodesk_pg' volume ma safe rahe chhe.",
        cmd: "docker compose up -d --build",
      },
      {
        title: "4. Browser kholo",
        body: "http://localhost:3000 kholo. Logs jova, stop karva ane update karva nichena commands vapro.",
        cmd: "docker compose logs -f app     # logs\ndocker compose down            # stop (data safe)\ndocker compose up -d --build   # update / restart",
      },
      {
        title: "5. Admin account + encryption key",
        body: "Pehli vaar logs ma FIRST-RUN SETUP CODE dekhashe — /login par te code thi admin banavo. Broker keys encryption mate APP_SECRET set karo.",
        cmd: "docker compose logs app | grep -A2 \"SETUP CODE\"\necho APP_SECRET=$(openssl rand -hex 32) >> .env\ndocker compose up -d",
      },
    ],
  },
  {
    id: "linux",
    label: "Linux / macOS",
    icon: "🐧",
    intro: "Ubuntu / Debian / macOS mate. Setup script badhu aapmele kare chhe.",
    steps: [
      {
        title: "1. Node.js 22 + PostgreSQL install karo",
        body: "Ubuntu mate nichena commands. macOS: brew install node@22 postgresql@16 && brew services start postgresql@16.",
        cmd: "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\nsudo apt-get install -y nodejs postgresql unzip\nsudo -u postgres psql -c \"ALTER USER postgres PASSWORD 'postgres';\"",
      },
      {
        title: "2. macOS only — postgres user banavo",
        body: "Homebrew PostgreSQL ma default user tamaru Mac username hoy chhe. 'postgres' user banavo athva .env ma DATABASE_URL badlo.",
        cmd: "createuser -s postgres\npsql -d postgres -c \"ALTER USER postgres PASSWORD 'postgres';\"",
      },
      {
        title: "3. Extract + setup script",
        body: "Script .env banave chhe, npm ci, build ane start kare chhe.",
        cmd: "unzip algodesk-india-*.zip && cd algodesk-india\nbash scripts/setup.sh",
      },
      {
        title: "4. Pachhi thi start",
        body: "Build pachhi fakt npm start. Biju port joie to PORT variable vapro.",
        cmd: "npm start\n# or\nPORT=3001 npm start",
      },
    ],
  },
  {
    id: "vps",
    label: "VPS 24×7",
    icon: "☁",
    badge: "Live Algo",
    intro: "Algo aakho divas PC chalu rakhya vagar chalava mate Ubuntu VPS (Mumbai region, 2 GB RAM). Static IP male chhe je broker API whitelist mate jaruri chhe.",
    steps: [
      {
        title: "1. VPS lo + timezone set karo",
        body: "AWS Lightsail / DigitalOcean / Hostinger — Mumbai region, Ubuntu 24.04. SSH thi login karo.",
        cmd: "sudo timedatectl set-timezone Asia/Kolkata",
      },
      {
        title: "2. Node.js + PostgreSQL",
        body: "DB password strong rakho ane te j .env ma lakho.",
        cmd: "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\nsudo apt-get install -y nodejs postgresql unzip\nsudo -u postgres psql -c \"ALTER USER postgres PASSWORD 'StrongDbPass123';\"",
      },
      {
        title: "3. Upload + .env (APP_SECRET + admin)",
        body: "Zip ne scp / FileZilla thi upload karo. init-env strong APP_SECRET banave chhe. Admin: .env ma ADMIN_USERNAME/ADMIN_PASSWORD athva pm2 logs ma dekhato setup code.",
        cmd: "unzip algodesk-india-*.zip && cd algodesk-india\nnode scripts/admin-cli.mjs init-env\nnano .env\n#   DATABASE_URL=postgresql://postgres:StrongDbPass123@127.0.0.1:5432/app_db\n#   ADMIN_USERNAME=owner\n#   ADMIN_PASSWORD=Very#Strong2026Pass   (login pachhi kadhi nakho)",
      },
      {
        title: "4. Build + pm2 (auto-restart & reboot par start)",
        body: "pm2 app ne background ma chalu rakhe chhe ane server reboot pachhi pan start kare chhe.",
        cmd: "npm ci && npm run build\nsudo npm i -g pm2\npm2 start npm --name algodesk -- start\npm2 save && pm2 startup",
      },
      {
        title: "5. Firewall + open",
        body: "http://SERVER_IP:3000 kholo → admin login → turant 2FA chalu karo. VPS par HTTPS (nginx + certbot) jaruri. VPS no IP broker portal ma whitelist karo.",
        cmd: "sudo ufw allow OpenSSH\nsudo ufw allow 3000/tcp\nsudo ufw enable\npm2 logs algodesk",
      },
    ],
  },
];

export const MAINTENANCE: { title: string; body: string; cmd?: string }[] = [
  {
    title: "🔄 Update (navi version)",
    body: "Navi zip extract karo, juno .env file copy karo, pachhi setup fari chalavo. Database data safe rahe chhe — nava tables/columns aapmele umerai jay chhe.",
    cmd: "npm ci\nnpm run build\nnpm start            # or: pm2 restart algodesk",
  },
  {
    title: "💾 Backup database",
    body: "Roj ke weekly backup lo. Docker ma: docker exec algodesk-db pg_dump -U postgres app_db > backup.sql",
    cmd: "pg_dump -U postgres -h 127.0.0.1 app_db > algodesk-backup.sql",
  },
  {
    title: "♻ Restore database",
    body: "Backup file parthi data pachhu lavo (app bandh kari ne).",
    cmd: "psql -U postgres -h 127.0.0.1 -d app_db -f algodesk-backup.sql",
  },
  {
    title: "⏹ Stop / Restart",
    body: "Windows: black window bandh karo. pm2: nichena commands. Docker: docker compose down / up -d.",
    cmd: "pm2 stop algodesk\npm2 restart algodesk",
  },
];

export const TROUBLESHOOT: { q: string; a: string; cmd?: string }[] = [
  {
    q: "Admin password bhuli gaya / account locked",
    a: "Server par (je folder ma app chhe) CLI thi password reset karo — account unlock thashe ane badha sessions logout thashe.",
    cmd: "node scripts/admin-cli.mjs reset-password admin \"New#Strong2026\"\nnode scripts/admin-cli.mjs unlock admin",
  },
  {
    q: "2FA phone khovai gayo",
    a: "Biju admin Users tab ma 'Reset 2FA' kare, athva server par CLI vapro. Login pachhi navo QR scan karo.",
    cmd: "node scripts/admin-cli.mjs disable-2fa admin",
  },
  {
    q: "Setup code kya chhe? (first run)",
    a: "Server ni black window / terminal / pm2 logs ma 'FIRST-RUN SETUP CODE' chhapay chhe. Restart karo to navo code aave.",
    cmd: "pm2 logs algodesk --lines 50\ndocker compose logs app",
  },
  {
    q: "Live feed connect nathi thato",
    a: "Dhan: access token 24h/30d valid hoy chhe ane Data API plan jaruri. Angel One: Brokers page par 🔐 Login (feed token). Live Feed page par error message juo.",
  },
  {
    q: "ECONNREFUSED 127.0.0.1:5432",
    a: "PostgreSQL chalu nathi. Windows: Win+R → services.msc → postgresql-x64-16 → Start. Pachhi Admin & Security → Security Checklist → Repair database.",
  },
  {
    q: "password authentication failed for user \"postgres\"",
    a: ".env ma DATABASE_URL no password PostgreSQL install vakhte rakhela password jevo j rakho.",
    cmd: "DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/app_db",
  },
  {
    q: "Port 3000 already in use",
    a: "Biju app 3000 vapre chhe. Biju port vapro (PORT .env ma kaam nathi karto — command ma aapo).",
    cmd: "set PORT=3001 && npm start        (Windows cmd)\nPORT=3001 npm start               (Linux / macOS)",
  },
  {
    q: "npm.ps1 cannot be loaded (PowerShell)",
    a: "Command Prompt (cmd) vapro athva PowerShell policy badlo.",
    cmd: "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
  },
  {
    q: "Tables missing / DB warning",
    a: "Admin & Security → Security Checklist tab ma 'Repair database' dabavo — badha tables ane nava columns fari banshe.",
  },
  {
    q: "Yahoo feed 'Fallback'",
    a: "Internet / firewall Yahoo block kare chhe. App simulator thi chalu rahe chhe. Yahoo quotes aam pan ~15 min delayed hoy chhe; real-time mate broker WebSocket feed jaruri.",
  },
  {
    q: "Live order rejected — IP not allowed",
    a: "SEBI retail-algo niyam mujab broker API orders mate static IP registration mange chhe. Admin & Security → Security Checklist ma dekhato Public IP tamara Dhan / Angel One / Kotak Neo API portal ma whitelist karo.",
  },
  {
    q: "npm install ghanu dhimu / fail",
    a: "Internet check karo, pachhi cache saaf kari fari try karo.",
    cmd: "npm cache clean --force\nnpm install",
  },
];
