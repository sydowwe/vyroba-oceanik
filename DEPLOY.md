# Nasadenie na Hostinger VPS + EasyPanel (s PostgreSQL)

Pri pushi do `master` GitHub Action (`.github/workflows/deploy.yml`):

1. zostaví Docker image a pushne ho do GHCR: `ghcr.io/sydowwe/vyroba-oceanik:latest` (+ tag so SHA commitu),
2. zavolá **Deploy Webhook** EasyPanelu, ktorý stiahne nový image a reštartuje appku,
3. (voliteľne) počká, kým `/healthz` vráti SHA nového commitu.

Dáta (zákazky, terasy, opravy, sklad) sa ukladajú do PostgreSQL. Tabuľka `app_state`
obsahuje aktuálny stav, `app_state_history` automatické zálohy (najviac raz za 15 min na kolekciu).
Tabuľky si server vytvorí sám pri štarte.

## 1. EasyPanel – databáza

1. V EasyPanel otvor (alebo vytvor) projekt, napr. `oceanik`.
2. **+ Service → Postgres**, názov napr. `db`. Vytvor.
3. V službe `db` → **Credentials** skopíruj **Internal Connection URL**, vyzerá napr.
   `postgres://postgres:HESLO@oceanik_db:5432/oceanik`
4. Odporúčané: v `db` → **Backups** nastav pravidelné zálohy.

## 2. EasyPanel – appka

1. **+ Service → App**, názov napr. `vyroba`.
2. **Source → Docker Image**: `ghcr.io/sydowwe/vyroba-oceanik:latest`
   - Ak je repozitár/balík súkromný, vyplň **Username** = tvoj GitHub login a **Password** =
     GitHub Personal Access Token (classic) so scope `read:packages`.
   - (Alternatíva: v GitHube → Packages → `vyroba-oceanik` → Package settings → zmeň viditeľnosť na Public;
     potom prihlasovacie údaje netreba. Dáta v image nie sú, iba kód.)
3. **Environment**:
   ```
   DATABASE_URL=postgres://postgres:HESLO@oceanik_db:5432/oceanik
   ```
4. **Domains**: pridaj doménu (napr. `vyroba.tvojadomena.sk`), port **3000**, zapni HTTPS.
5. **Deploy** (prvý raz ručne – najprv musí prebehnúť GitHub Action, aby image existoval).
6. **Deployments → Deploy Webhook** – skopíruj URL.

## 3. GitHub – nastavenia repozitára

V `Settings → Secrets and variables → Actions`:

| Typ      | Názov                       | Hodnota                                        |
|----------|-----------------------------|------------------------------------------------|
| Secret   | `EASYPANEL_DEPLOY_WEBHOOK`  | URL z EasyPanel → Deployments → Deploy Webhook |
| Variable | `APP_URL` *(voliteľné)*     | `https://vyroba.tvojadomena.sk`                |

Workflow používa environment `production` – GitHub ho vytvorí automaticky pri prvom behu;
môžeš ho použiť na schvaľovanie nasadení (Settings → Environments).

Nasadenie spustíš pushom do `master` alebo ručne: **Actions → Build & Deploy (EasyPanel) → Run workflow**.

## 4. Presun existujúcich dát

- Dáta z lokálnej appky sa na server neprenesú samé (localStorage patrí ku konkrétnej adrese). Postup:
  1. v starej (lokálnej) appke klikni **↓ Export**,
  2. v nasadenej appke klikni **↑ Import** a vyber exportovaný súbor – dáta sa uložia do PostgreSQL.
- Prázdna databáza sa pri prvom otvorení naplní tým, čo má prehliadač práve v localStorage (inak ukážkovými dátami).

## Ako to funguje v prehliadači

- localStorage ostáva rýchla cache, ale pri štarte má prednosť stav zo servera.
- Každá zmena sa po ~0,4 s odošle na server. Indikátor vpravo hore ukazuje
  `✓ uložené na server` / `⚠ neuložené na server` (pri výpadku sa opakuje každých 5 s).
- Ak dáta zmení niekto iný, appka ich načíta pri návrate na kartu a každých 30 s (nie počas písania).
- Ukladá sa vždy celá kolekcia (napr. všetky zákazky) – ak dvaja ľudia upravujú **v tom istom momente**,
  vyhrá posledný zápis. Pre malý tím to stačí; staršie verzie sú v `app_state_history`.
- Lokálny režim (`Spusti appku.bat` / otvorenie súboru) funguje ďalej bez servera.

## Lokálne spustenie servera

```bash
npm install
DATABASE_URL=postgres://postgres:heslo@localhost:5432/oceanik npm start
# http://localhost:3000
```

## Obnova zo zálohy (história)

```sql
-- posledné zálohy zákaziek
SELECT id, rev, saved_at, jsonb_array_length(data) FROM app_state_history
WHERE key = 'zakazky' ORDER BY saved_at DESC LIMIT 20;

-- obnoviť konkrétnu zálohu
UPDATE app_state SET data = (SELECT data FROM app_state_history WHERE id = 123),
       rev = nextval('app_rev_seq'), updated_at = now()
WHERE key = 'zakazky';
```

Celý aktuálny stav sa dá stiahnuť aj cez `GET /api/export`.
