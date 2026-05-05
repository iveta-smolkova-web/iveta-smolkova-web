// Netlify Function: /api/leads
// Přijímá POST z quizu na prodej-bytu, zakládá Person + Deal v Pipedrive.
//
// Env vars (Netlify → Site settings → Environment variables):
//   PIPEDRIVE_TOKEN     — API token z Pipedrive (Settings → Personal preferences → API)
//   PIPEDRIVE_DOMAIN    — subdoména, např. "zatimneni" (z URL zatimneni.pipedrive.com)
//   PIPELINE_NAME       — volitelné, default "Prodej - reklama"

const TOKEN = process.env.PIPEDRIVE_TOKEN;
const DOMAIN = process.env.PIPEDRIVE_DOMAIN || 'zatimneni';
const PIPELINE_NAME = process.env.PIPELINE_NAME || 'Prodej - reklama';
const API_BASE = `https://${DOMAIN}.pipedrive.com/api/v1`;

// Existující "Web — *" custom field klíče (z Pipedrive exportu)
const FIELD_KEY = {
  cityKey:       '5a4b9e20836e69f82ae194201909281b9da58110', // Web — Lokalita město
  layoutKey:     '36757288a91b8a6d43bf5c17c7b39c5a26c4cbb0', // Web — Dispozice
  conditionKey:  'e9df973bec161537b64087364eef225b926538a5', // Web — Stav nemovitosti
  timingKey:     'c643300f711b06e4fd13fd28f19346ea45a1a8b4', // Web — Naléhavost
  sourceKey:     '57127e518c590d1bebd81cc036e749149b5afd0d', // Zdroj leadu
};

// Mapování quiz hodnot → Pipedrive option IDs (z exportu data_fields_options_2026-05-05.xls)
const OPT = {
  city: { 'Brno': 116, 'Olomouc': 117, 'Zlín': 118, 'other': 119 },
  layout: { '1+kk': 120, '1+1': 121, '2+kk': 122, '2+1': 123, '3+kk': 124, '3+1': 125, '4+kk': 126, '4+1': 127, '5+': 128 },
  condition: { 'new': 130, 'good': 131, 'original': 132, 'dont-know': 133 },
  timing: { 'asap': 112, '3m': 113, '6m': 114, 'later': 115 },
  source: { 'Web': 61 },
};

// Lidsky čitelné labely pro note v Pipedrive
const LABEL = {
  layout: { '1+kk':'1+kk','1+1':'1+1','2+kk':'2+kk','2+1':'2+1','3+kk':'3+kk','3+1':'3+1','4+kk':'4+kk','4+1':'4+1','5+':'5 a více' },
  condition: { 'new':'Novostavba / kompletně rekonstruovaný', 'good':'Po dílčí rekonstrukci, dobrý stav', 'original':'Původní stav, k rekonstrukci', 'dont-know':'Nevím, posoudíme spolu' },
  timing: { 'asap':'Co nejdřív (do 30 dní)', '3m':'Do 3 měsíců', '6m':'Do půl roku', 'later':'Zatím se rozhoduji' },
  ownership: { 'sole':'Jediný vlastník', 'shared':'Spolu s někým', 'inheritance':'Dědictví / probíhá řízení', 'other':'Jiné' },
};

// Cache (lambda warm) pro bootstrap výsledků
const cache = {
  pipelineId: null,
  stageId: null,
  areaFieldKey: null,
  ownershipFieldKey: null,
  ownershipOptions: null, // { sole: 12, shared: 13, ... }
};

// ----- Pipedrive API helper ------------------------------------------------
async function pd(path, opts = {}) {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}api_token=${TOKEN}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.success === false) {
    throw new Error(`Pipedrive ${opts.method || 'GET'} ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

// ----- Bootstrap: pipeline + custom fields ---------------------------------
async function ensurePipeline() {
  if (cache.pipelineId) return;
  const list = await pd('/pipelines');
  let p = (list.data || []).find(x => x.name === PIPELINE_NAME);
  if (!p) {
    const created = await pd('/pipelines', { method: 'POST', body: { name: PIPELINE_NAME, deal_probability: 1 } });
    p = created.data;
  }
  cache.pipelineId = p.id;
  // První stage v pipeline (deal musí mít stage_id)
  const stages = await pd(`/stages?pipeline_id=${p.id}`);
  let s = (stages.data || [])[0];
  if (!s) {
    const created = await pd('/stages', { method: 'POST', body: { name: 'Nový lead', pipeline_id: p.id } });
    s = created.data;
  }
  cache.stageId = s.id;
}

async function ensureCustomFields() {
  if (cache.areaFieldKey && cache.ownershipFieldKey) return;
  const fields = await pd('/dealFields');
  const all = fields.data || [];

  // Web — Plocha (m²)
  let area = all.find(f => f.name === 'Web — Plocha (m²)');
  if (!area) {
    const created = await pd('/dealFields', { method: 'POST', body: { name: 'Web — Plocha (m²)', field_type: 'double' } });
    area = created.data;
  }
  cache.areaFieldKey = area.key;

  // Web — Vlastnictví (single option)
  let own = all.find(f => f.name === 'Web — Vlastnictví');
  if (!own) {
    const created = await pd('/dealFields', {
      method: 'POST',
      body: {
        name: 'Web — Vlastnictví',
        field_type: 'enum',
        options: [
          { label: 'Jediný vlastník' },
          { label: 'Spolu s někým' },
          { label: 'Dědictví / probíhá řízení' },
          { label: 'Jiné' },
        ],
      },
    });
    own = created.data;
  }
  cache.ownershipFieldKey = own.key;
  // Mapuj option labely → IDs
  const opts = own.options || [];
  const findId = (label) => (opts.find(o => o.label === label) || {}).id;
  cache.ownershipOptions = {
    'sole': findId('Jediný vlastník'),
    'shared': findId('Spolu s někým'),
    'inheritance': findId('Dědictví / probíhá řízení'),
    'other': findId('Jiné'),
  };
}

// ----- Person: najdi přes telefon/email, jinak vytvoř ----------------------
async function findOrCreatePerson({ name, email, phone }) {
  // Hledej přes /persons/search (full-text), filtr podle email nebo phone
  const term = email || phone || name;
  if (term) {
    const search = await pd(`/persons/search?term=${encodeURIComponent(term)}&fields=email,phone,name&exact_match=false`);
    const items = (search.data && search.data.items) || [];
    const match = items.find(it => {
      const it2 = it.item || {};
      const emails = (it2.emails || []).map(e => (e || '').toLowerCase());
      const phones = (it2.phones || []).map(p => (p || '').replace(/\s+/g, ''));
      return (email && emails.includes(email.toLowerCase()))
        || (phone && phones.includes((phone || '').replace(/\s+/g, '')));
    });
    if (match) return match.item.id;
  }
  const created = await pd('/persons', {
    method: 'POST',
    body: {
      name: name || email || phone || 'Zájemce z webu',
      email: email ? [{ value: email, primary: true, label: 'work' }] : undefined,
      phone: phone ? [{ value: phone, primary: true, label: 'mobile' }] : undefined,
    },
  });
  return created.data.id;
}

// ----- Handler -------------------------------------------------------------
export default async (req) => {
  // CORS / preflight
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...cors } });
  }
  if (!TOKEN) {
    return new Response(JSON.stringify({ error: 'PIPEDRIVE_TOKEN not configured' }), { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }); }

  const { city, layout, area, condition, timing, ownership, name, phone, email, gdpr, source, ts } = body || {};

  // Minimální validace
  if (!name || !phone || !email) {
    return new Response(JSON.stringify({ error: 'Chybí povinná pole: jméno, telefon nebo email.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors } });
  }
  if (!gdpr) {
    return new Response(JSON.stringify({ error: 'Chybí souhlas se zpracováním osobních údajů.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors } });
  }

  try {
    await ensurePipeline();
    await ensureCustomFields();
    const personId = await findOrCreatePerson({ name, email, phone });

    // Připrav custom fieldy pro deal
    const customFields = {};
    if (city && OPT.city[city] !== undefined) customFields[FIELD_KEY.cityKey] = OPT.city[city];
    if (layout && OPT.layout[layout] !== undefined) customFields[FIELD_KEY.layoutKey] = OPT.layout[layout];
    if (condition && OPT.condition[condition] !== undefined) customFields[FIELD_KEY.conditionKey] = OPT.condition[condition];
    if (timing && OPT.timing[timing] !== undefined) customFields[FIELD_KEY.timingKey] = OPT.timing[timing];
    customFields[FIELD_KEY.sourceKey] = OPT.source.Web; // 61 = "Web"
    if (area) customFields[cache.areaFieldKey] = Number(area) || null;
    if (ownership && cache.ownershipOptions[ownership]) customFields[cache.ownershipFieldKey] = cache.ownershipOptions[ownership];

    // Title dealu — užitečně formátovaný pro inbox
    const cityLabel = city === 'other' ? 'Jiné' : (city || '?');
    const layoutLabel = (LABEL.layout[layout] || layout || '?');
    const dealTitle = `${cityLabel} · ${layoutLabel}${area ? ' · ' + area + ' m²' : ''} — ${name}`;

    const dealBody = {
      title: dealTitle,
      person_id: personId,
      pipeline_id: cache.pipelineId,
      stage_id: cache.stageId,
      ...customFields,
    };
    const deal = await pd('/deals', { method: 'POST', body: dealBody });
    const dealId = deal.data.id;

    // Note s kompletní rekapitulací (pro rychlou orientaci v Pipedrive)
    const noteHtml = `
      <p><strong>Nový lead z webu — prodej bytu</strong></p>
      <ul>
        <li><strong>Jméno:</strong> ${escapeHtml(name)}</li>
        <li><strong>Telefon:</strong> ${escapeHtml(phone)}</li>
        <li><strong>E-mail:</strong> ${escapeHtml(email)}</li>
        <li><strong>Město:</strong> ${escapeHtml(cityLabel)}</li>
        <li><strong>Dispozice:</strong> ${escapeHtml(layoutLabel)}</li>
        <li><strong>Plocha:</strong> ${area ? escapeHtml(String(area)) + ' m²' : '—'}</li>
        <li><strong>Stav:</strong> ${escapeHtml(LABEL.condition[condition] || condition || '—')}</li>
        <li><strong>Termín prodeje:</strong> ${escapeHtml(LABEL.timing[timing] || timing || '—')}</li>
        <li><strong>Vlastnictví:</strong> ${escapeHtml(LABEL.ownership[ownership] || ownership || '—')}</li>
        <li><strong>GDPR souhlas:</strong> ano</li>
        <li><strong>Zdroj:</strong> ${escapeHtml(source || 'web')}</li>
        <li><strong>Čas odeslání:</strong> ${escapeHtml(ts || new Date().toISOString())}</li>
      </ul>
    `;
    await pd('/notes', { method: 'POST', body: { content: noteHtml, deal_id: dealId, person_id: personId } });

    return new Response(JSON.stringify({ ok: true, dealId, personId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (err) {
    console.error('leads function error:', err);
    return new Response(JSON.stringify({ error: 'Interní chyba — zkuste to prosím znovu nebo zavolejte přímo.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
