# Selfie do Telegramu

Samostatná česká webová aplikace pro živý náhled kamery a ruční odeslání selfie do nakonfigurovaného Telegram chatu provozovatele. Běží na Cloudflare Workers a D1, bez placeného serveru, persistentního disku, Python backendu nebo polling procesu. Bot přijímá pouze Telegram webhook.

Veřejné odkazy mají viditelnou cestu `/selfie/<náhodný-kód>` a vedou přímo na selfie stránku. Ještě před žádostí o přístup ke kameře stránka oznamuje, že po stisku **Pořídit a odeslat selfie** odešle fotografii do Telegram chatu provozovatele. Náhled je lokální, kamera se spustí jen po samostatném kliknutí a lze ji vypnout. Fotografie se neukládá. Není zde automatické focení ani sledování kliknutí.

## Nasazení zdarma na Cloudflare

Požadavky: Node.js 20+, účet Cloudflare a Telegram účet. Workers Free a D1 Free stačí pro tento projekt; nejsou vytvořeny placené prostředky. Kvóty Cloudflare se mohou měnit. Nasazení vyžaduje autorizaci Cloudflare CLI ve vašem prohlížeči, ale heslo ani token neposílejte do chatu.

### 1. Instalace a připojení Cloudflare

V kořeni repozitáře:

```powershell
npm.cmd install
npx wrangler login
```

Příkaz otevře přihlášení Cloudflare ve vašem vlastním prohlížeči. Vytvořte D1 databázi:

```powershell
npx wrangler d1 create telegram-selfie-links --binding DB --update-config
```

Wrangler vytvoří databázi a zapíše skutečné `database_id` do `wrangler.jsonc` místo ukázkového nulového UUID. Zkontrolujte změnu konfigurace před migrací a deployem. Přihlášený Wrangler projekt a D1 databáze patří k vašemu účtu; databáze je v bezplatném plánu.

### 2. Telegram bot a bezpečné secrets

V Telegramu vytvořte bota přes [@BotFather](https://t.me/BotFather). Přidejte ho do cílového soukromého chatu nebo skupiny, kam se mají doručovat fotografie, a ověřte, že může posílat zprávy. Tajný bot token neukládejte do souboru ani repozitáře.

Nastavte tyto Worker secrets v Cloudflare Dashboard: **Workers & Pages → `telegram-selfie-page` → Settings → Variables and Secrets → Add**. U každé hodnoty zvolte typ **Secret** (encrypted); token nevkládejte do `wrangler.jsonc`, GitHubu ani chatu:

- `TELEGRAM_BOT_TOKEN`: token od BotFather.
- `TELEGRAM_CHAT_ID`: cílový chat pro fotografie. ID skupiny obvykle začíná minus.
- `ADMIN_TELEGRAM_USER_ID`: vaše číselné Telegram user ID. Jen tento účet smí v soukromém chatu s botem vytvořit odkaz. Zjistíte ho tak, že botovi pošlete `/whoami`; bot ID pošle přímo do soukromé konverzace a nikam ho neukládá. Příkaz funguje pouze v soukromé konverzaci a ID se nikam neukládá.
- `TELEGRAM_WEBHOOK_SECRET`: náhodný řetězec pouze z písmen, číslic, `_` nebo `-`; Telegram ho posílá jako autentizační HTTP hlavičku.
- `WEBHOOK_SETUP_KEY`: samostatný náhodný tajný klíč pro jednorázové přihlášení endpointu, který nastaví Telegram webhook.

Oba webhook klíče vytvořte lokálně například `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` a vložte je přímo do dashboardu. Nepoužívejte jeden token jako oba klíče. Změna Secrets může vyžadovat nové nasazení; dokončete ho podle pokynů v Dashboardu.

### 3. URL a nasazení

Worker je nasazený na `https://telegram-selfie-page.millo-lawa.workers.dev`; tato hodnota je nastavena v `wrangler.jsonc`. Pokud změníte doménu, aktualizujte `PUBLIC_BASE_URL` na HTTPS origin bez cesty. Pro další nasazení:

```powershell
npm test
npx wrangler d1 migrations apply telegram-selfie-links --remote
npx wrangler deploy
```

Názvy aplikace a databáze jsou v `wrangler.jsonc`; `wrangler deploy` nasadí Worker i statické soubory.

### 4. Nastavení webhooku

Po nasazení a uložení všech Worker secrets nastavte Telegram webhook jednorázově přes zabezpečený endpoint. Následující PowerShell příkaz skryje klíč při zadávání a vynuluje jeho paměťovou kopii po použití:

```powershell
$secure = Read-Host "WEBHOOK_SETUP_KEY" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  Invoke-RestMethod -Method Post `
    -Uri "https://telegram-selfie-page.<váš-workers-subdomain>.workers.dev/api/admin/configure-webhook" `
    -Headers @{ Authorization = "Bearer $key" }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable key, secure, ptr -ErrorAction SilentlyContinue
}
```

Endpoint použije `TELEGRAM_WEBHOOK_SECRET` z Worker secrets při volání Telegram `setWebhook`. Služba neprovádí long polling a nepoužívá token v klientském JavaScriptu. Pro další nové odkazy napište botovi v soukromém chatu `/newlink` nebo `/start`; obojí vytvoří nový veřejný odkaz. Ostatní účty ani skupinové konverzace příkazy neobslouží.

## D1 a soukromí

`migrations/0001_create_tables.sql` vytvoří tabulku odkazů a idempotentní tabulku Telegram update ID. Kód odkazu obsahuje 96 bitů odvozených HMAC-SHA-256 z tajného bot tokenu a update ID, proto opakovaný webhook pro stejný Telegram příkaz vrátí tentýž odkaz. D1 ukládá pouze SHA-256 otisk kódu, datum vytvoření a Telegram update ID s chat ID nutné pro opakované zpracování; nikdy fotografie. Odkazy neexpirují a není implementováno měření kliknutí.

Backend přijímá pouze JPEG a PNG do 5 MB, kontroluje typ a signaturu a přeposílá fotku přes Telegram Bot API. Návštěvník je před povolením kamery informován o cíli odeslání. Fotografie jde přímo k Telegramu a není trvale uložena ve Workeru ani D1.

## Lokální vývoj a testy

```powershell
npm.cmd install
npx wrangler d1 migrations apply telegram-selfie-links --local
npm test
npm run dev
```

Testy běží offline na Node.js built-in test runneru; Telegram volání jsou simulována a nevyžadují kameru, Cloudflare účet ani tajné hodnoty. Pro lokální plnohodnotný test webhooku lze nastavit secrets přes Wrangler lokální secrets mechanismus nebo `.dev.vars` (nikdy tento soubor necommitujte).
