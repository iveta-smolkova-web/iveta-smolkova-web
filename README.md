# iveta-smolkova-web

Astro 5 + Tailwind landing page pro **Mgr. Iveta Smolková**, realitní makléřku v Brně, Olomouci a Zlíně. Deploy: Netlify. Lead capture: Pipedrive (přes Netlify Function).

## Stránky

- `/` — Home (hero, problémy, postup, reference, sekce o Ivetě, FAQ, CTA)
- `/prodej-bytu` — 8krokový kvíz s POST na `/api/leads`
- `/dekujeme` — Thank-you stránka

## Lokální vývoj

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # vygeneruje dist/
```

## Deploy

Push na `main` → automatický build na Netlify.

- Build command: `npm run build`
- Publish dir: `dist`
- Functions dir: `netlify/functions`

## Pipedrive integrace

Function `netlify/functions/leads.mjs` přijímá quiz data, zakládá Person + Deal v pipeline „Prodej - reklama" v `zatimneni.pipedrive.com`. První spuštění auto-bootstrapne pipeline + chybějící custom fieldy.

### Env vars (Netlify → Site settings → Environment variables)

| Klíč | Hodnota |
|---|---|
| `PIPEDRIVE_TOKEN` | API token z Pipedrive (Settings → Personal preferences → API) |
| `PIPEDRIVE_DOMAIN` | `zatimneni` |
| `PIPELINE_NAME` | volitelné, default `Prodej - reklama` |

## Struktura

```
src/
├── layouts/Layout.astro     # SEO head, Schema.org RealEstateAgent
├── components/{Nav,Footer}.astro
└── pages/{index,prodej-bytu,dekujeme}.astro
public/
├── favicon.svg, robots.txt
└── images/{iveta-logo-full.png, iveta-portrait.jpg}
netlify/functions/leads.mjs  # Pipedrive lead handler
netlify.toml                 # redirect /api/leads → /.netlify/functions/leads
```
