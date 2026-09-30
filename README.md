# Selfie do Telegramu

Samostatná česká webová aplikace pro živý náhled přední kamery a ruční pořízení a odeslání selfie do nakonfigurovaného Telegram chatu. Odkazy lze generovat příkazem Telegram bota `/newlink` (nebo `/start`); jejich cesta `/selfie/<náhodný-kód>` zůstává zřetelná a vede přímo na stránku pro selfie. Na stránce je ještě před povolením kamery uvedeno, že fotografie se odešle do Telegram chatu provozovatele.

Kamera se zapíná až po kliknutí na **Zapnout kameru** a lze ji kdykoliv vypnout. Fotografie se pořídí a odešle výhradně po kliknutí na **Pořídit a odeslat selfie**. Server ji neukládá na disk. Neshromažďují se údaje o návštěvnících ani kliknutích na odkazy.

## Nasazení na Render

V repozitáři je Render Blueprint `render.yaml`. Vytvořte nový Blueprint z tohoto repozitáře. Konfigurace používá jeden webový proces a 1GB persistentní disk připojený do `/var/data`; persistentní disky vyžadují placený plán Renderu. Aplikaci neškálujte na více instancí: Telegram bot používá dlouhé polling spojení a má běžet jen jednou.

Vytvořte Telegram bota přes [@BotFather](https://t.me/BotFather) a jeho token vložte pouze do Render env var `TELEGRAM_BOT_TOKEN`. Do `TELEGRAM_CHAT_ID` vložte ID soukromého chatu nebo skupiny, kam se mají doručovat fotografie; přidejte do něj bota a ověřte, že může posílat zprávy. Pro skupinu bývá ID záporné.

Nastavte také:

- `ADMIN_TELEGRAM_USER_ID`: vaše kladné číselné Telegram user ID. Jen tento účet může botovi v soukromé konverzaci posílat `/start` a `/newlink`. Najdete ho například přes důvěryhodného Telegram ID bota.
- `BASE_URL`: veřejný HTTPS origin aplikace, například `https://nazev-sluzby.onrender.com` (bez cesty za doménou). Na Renderu může zůstat prázdná; aplikace pak použije automatickou proměnnou `RENDER_EXTERNAL_URL`. Nastavte ji ručně jen při použití vlastní domény nebo pokud automatická adresa není vhodná.
- `DATABASE_PATH`: Blueprint jej nastavuje na `/var/data/links.sqlite3`. Neměňte jej na dočasnou cestu mimo připojený disk, jinak se odkazy po restartu ztratí.

Render zobrazí hodnoty `sync: false` jako proměnné, které je nutné doplnit: nastavte token, cílový chat a své admin user ID. Token nikomu neposílejte ani jej neukládejte do repozitáře. Po deployi otevřete soukromou konverzaci s botem a pošlete `/newlink`; bot odpoví přímým selfie odkazem a jasným upozorněním na odesílání fotografie. `/start` vytvoří nový odkaz také. Odkazy nemají sledování kliknutí ani automatické vypršení; platí, dokud existuje záznam na persistentním disku.

Bot používá Telegram `getUpdates` polling. Pokud má tento bot nastavený webhook, před spuštěním polling aplikace ho odstraňte; Telegram neumožňuje současně používat webhook a `getUpdates`.

Tato změna pouze přidává manifest a instrukce; aplikace nebyla nasazena.

## Lokální spuštění

Požadavky: Python 3.10 nebo novější. Kamera v prohlížeči funguje na `localhost` nebo přes HTTPS.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Do `.env` vložte hodnoty `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TELEGRAM_USER_ID` a `BASE_URL`. Pro lokální bot linky použijte `BASE_URL=http://localhost:8000`. Spusťte server příkazem:

```powershell
python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000 --workers 1
```

Otevřete <http://127.0.0.1:8000>. Lokální výchozí SQLite databáze je `data/links.sqlite3`; v produkci použijte persistentní úložiště a `DATABASE_PATH` nastavte na jeho cestu.

## Soukromí a limity

Backend přijímá pouze JPEG a PNG do 5 MB a předává je Telegram Bot API. Fotografie se neukládají na webový server; Telegram ji doručí do nastaveného chatu. Živý náhled zůstává v prohlížeči. Každý vygenerovaný náhodný kód má 96 bitů entropie; v SQLite se ukládá pouze jeho SHA-256 otisk, nikoliv původní kód. Databáze uchovává záznamy odkazů a idempotentní stav příkazů bota na persistentním disku.

## Offline testy

Testy nepovolují kameru ani nekontaktují Telegram; síťová odpověď bota je simulovaná.

```powershell
python -m unittest discover -s tests -v
```
