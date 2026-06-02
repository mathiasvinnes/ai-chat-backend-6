# AI-salong (multi-tenant)

Én Render-instans betjener alle salonger. Hver salong identifiseres med en `slug`
og hentes fra Supabase-tabellen `salonger`.

## 1. Supabase
Kjør `supabase-schema.sql` i Supabase (SQL Editor) én gang. Det lager tabellene
`salonger` og `samtaler` med Row Level Security på.

## 2. Miljøvariabler på Render
Sett disse under Render → Service → Environment:

| Variabel              | Påkrevd | Forklaring                                                        |
|-----------------------|---------|-------------------------------------------------------------------|
| `OPENAI_API_KEY`      | Ja      | OpenAI-nøkkel (gpt-4o-mini)                                        |
| `SUPABASE_URL`        | Ja      | F.eks. `https://xxxx.supabase.co`                                 |
| `SUPABASE_KEY`        | Ja      | **service_role**-nøkkelen (ikke anon) – serveren omgår RLS        |
| `ADMIN_TOKEN`         | Ja      | Lang, hemmelig streng. Kreves for `/provision` og `/admin/*`      |
| `CAL_API_KEY`         | Ja*     | Standard Cal.com-nøkkel (kan overstyres per salong)               |
| `CAL_EVENT_TYPE_ID`   | Ja*     | Standard Cal.com event type id                                    |
| `CAL_BASE`            | Nei     | Standard `https://api.cal.com/v2`. Sett til `.eu`-varianten ved EU-konto |
| `SENDGRID_KEY`        | Nei     | For e-postvarsler                                                 |
| `EPOST_FRA`           | Nei     | Verifisert SendGrid-avsender                                      |
| `ONBOARDING_EPOST`    | Nei     | Hvor onboarding-søknader sendes (faller tilbake til `EPOST_FRA`)  |
| `BASE_DOMAIN`         | Nei     | F.eks. `ai-salong.no` for subdomene-ruting (`kunde.ai-salong.no`) |
| `DEFAULT_SLUG`        | Nei     | Slug brukt når ingen kan utledes (standard `demo`)                |

`*` Cal.com kan settes per salong i `/provision`-kallet, men en standard er praktisk.

## 3. Aktivere en salong
Kunden fyller ut `/kom-igang`. Du får config-en på e-post. Aktiver den lokalt:

```bash
SERVER_URL=https://din-app.onrender.com \
ADMIN_TOKEN=din-hemmelige-token \
node aktiver-salong.mjs salong.json
```

Du får tilbake salongens URL og dashboard-nøkkel.

## 4. Slik når kundene salongen sin
- Med `BASE_DOMAIN`: `https://<slug>.ai-salong.no`
- Uten: `https://din-app.onrender.com/?salong=<slug>`

Chat, dashboard og widget plukker opp `slug` automatisk fra URL eller subdomene.