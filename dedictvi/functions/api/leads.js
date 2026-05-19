// Cloudflare Pages Function: /api/leads
// Přijímá POST z quizu na prodej-bytu / pronajem-bytu, zakládá Person + Deal v Pipedrive.
//
// Env vars (Cloudflare Pages → Settings → Environment variables):
//   PIPEDRIVE_TOKEN     — API token z Pipedrive
//   PIPEDRIVE_DOMAIN    — subdoména, např. "zatimneni" (z URL zatimneni.pipedrive.com)
//   PIPELINE_NAME       — volitelné, default "Prodej - reklama" (pro pronajem nastav "Pronájem - reklama")
//
// Ported from netlify/functions/leads.mjs — same logic, CF Pages handler format.

const FIELD_KEY = {
  cityKey:       '5a4b9e20836e69f82ae194201909281b9da58110',
  layoutKey:     '36757288a91b8a6d43bf5c17c7b39c5a26c4cbb0',
  conditionKey:  'e9df973bec161537b64087364eef225b926538a5',
  timingKey:     'c643300f711b06e4fd13fd28f19346ea45a1a8b4',
  sourceKey:     '57127e518c590d1bebd81cc036e749149b5afd0d',
};

const OPT = {
  city: { 'Brno': 116, 'Olomouc': 117, 'Zlín': 118, 'other': 119 },
  layout: { '1+kk': 120, '1+1': 121, '2+kk': 122, '2+1': 123, '3+kk': 124, '3+1': 125, '4+kk': 126, '4+1': 127, '5+': 128 },
  condition: { 'new': 130, 'good': 131, 'original': 132, 'dont-know': 133 },
  timing: { 'asap': 112, '3m': 113, '6m': 114, 'later': 115 },
  source: { 'Web': 61 },
};

const LABEL = {
  layout: { '1+kk':'1+kk','1+1':'1+1','2+kk':'2+kk','2+1':'2+1','3+kk':'3+kk','3+1':'3+1','4+kk':'4+kk','4+1':'4+1','5+':'5 a více' },
  condition: { 'new':'Novostavba / kompletně rekonstruovaný', 'good':'Po dílčí rekonstrukci, dobrý stav', 'original':'Původní stav, k rekonstrukci', 'dont-know':'Nevím, posoudíme spolu' },
  timing: { 'asap':'Co nejdřív (do 30 dní)', '3m':'Do 3 měsíců', '6m':'Do půl roku', 'later':'Zatím se rozhoduji' },
  ownership: { 'sole':'Jediný vlastník', 'shared':'Spolu s někým', 'inheritance':'Dědictví / probíhá řízení', 'other':'Jiné' },
};

const cache = {
  pipelineId: null,
  stageId: null,
  areaFieldKey: null,
  ownershipFieldKey: null,
  ownershipOptions: null,
};

function makeApi(token, domain) {
  const API_BASE = `https://${domain}.pipedrive.com/api/v1`;
  return async function pd(path, opts = {}) {
    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}api_token=${token}`;
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
  };
}

async function ensurePipeline(pd, pipelineName) {
  if (cache.pipelineId) return;
  const list = await pd('/pipelines');
  let p = (list.data || []).find(x => x.name === pipelineName);
  if (!p) {
    const created = await pd('/pipelines', { method: 'POST', body: { name: pipelineName, deal_probability: 1 } });
    p = created.data;
  }
  cache.pipelineId = p.id;
  const stages = await pd(`/stages?pipeline_id=${p.id}`);
  let s = (stages.data || [])[0];
  if (!s) {
    const created = await pd('/stages', { method: 'POST', body: { name: 'Nový lead', pipeline_id: p.id } });
    s = created.data;
  }
  cache.stageId = s.id;
}

async function ensureCustomFields(pd) {
  if (cache.areaFieldKey && cache.ownershipFieldKey) return;
  const fields = await pd('/dealFields');
  const all = fields.data || [];

  let area = all.find(f => f.name === 'Web — Plocha (m²)');
  if (!area) {
    const created = await pd('/dealFields', { method: 'POST', body: { name: 'Web — Plocha (m²)', field_type: 'double' } });
    area = created.data;
  }
  cache.areaFieldKey = area.key;

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
  const opts = own.options || [];
  const findId = (label) => (opts.find(o => o.label === label) || {}).id;
  cache.ownershipOptions = {
    'sole': findId('Jediný vlastník'),
    'shared': findId('Spolu s někým'),
    'inheritance': findId('Dědictví / probíhá řízení'),
    'other': findId('Jiné'),
  };
}

async function findOrCreatePerson(pd, { name, email, phone }) {
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// CF Pages Function entry point
export async function onRequest(context) {
  const { request, env } = context;
  const TOKEN = env.PIPEDRIVE_TOKEN;
  const DOMAIN = env.PIPEDRIVE_DOMAIN || 'zatimneni';
  const PIPELINE_NAME = env.PIPELINE_NAME || 'Prodej - reklama';

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }
  if (!TOKEN) {
    return jsonResponse({ error: 'PIPEDRIVE_TOKEN not configured' }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400, cors); }

  const { city, layout, area, condition, timing, ownership, name, phone, email, gdpr, source, ts } = body || {};

  if (!name || !phone || !email) {
    return jsonResponse({ error: 'Chybí povinná pole: jméno, telefon nebo email.' }, 400, cors);
  }
  if (!gdpr) {
    return jsonResponse({ error: 'Chybí souhlas se zpracováním osobních údajů.' }, 400, cors);
  }

  try {
    const pd = makeApi(TOKEN, DOMAIN);
    await ensurePipeline(pd, PIPELINE_NAME);
    await ensureCustomFields(pd);
    const personId = await findOrCreatePerson(pd, { name, email, phone });

    const customFields = {};
    if (city && OPT.city[city] !== undefined) customFields[FIELD_KEY.cityKey] = OPT.city[city];
    if (layout && OPT.layout[layout] !== undefined) customFields[FIELD_KEY.layoutKey] = OPT.layout[layout];
    if (condition && OPT.condition[condition] !== undefined) customFields[FIELD_KEY.conditionKey] = OPT.condition[condition];
    if (timing && OPT.timing[timing] !== undefined) customFields[FIELD_KEY.timingKey] = OPT.timing[timing];
    customFields[FIELD_KEY.sourceKey] = OPT.source.Web;
    if (area) customFields[cache.areaFieldKey] = Number(area) || null;
    if (ownership && cache.ownershipOptions[ownership]) customFields[cache.ownershipFieldKey] = cache.ownershipOptions[ownership];

    const cityLabel = city === 'other' ? 'Jiné' : (city || '?');
    const layoutLabel = (LABEL.layout[layout] || layout || '?');
    const sourceLabel = source || 'web';
    const isPronajem = String(sourceLabel).includes('pronajem') || PIPELINE_NAME.toLowerCase().includes('pronájem') || PIPELINE_NAME.toLowerCase().includes('pronajem');
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

    const noteHtml = `
      <p><strong>Nový lead z webu — ${isPronajem ? 'pronájem bytu' : 'prodej bytu'}</strong></p>
      <ul>
        <li><strong>Jméno:</strong> ${escapeHtml(name)}</li>
        <li><strong>Telefon:</strong> ${escapeHtml(phone)}</li>
        <li><strong>E-mail:</strong> ${escapeHtml(email)}</li>
        <li><strong>Město:</strong> ${escapeHtml(cityLabel)}</li>
        <li><strong>Dispozice:</strong> ${escapeHtml(layoutLabel)}</li>
        <li><strong>Plocha:</strong> ${area ? escapeHtml(String(area)) + ' m²' : '—'}</li>
        <li><strong>Stav:</strong> ${escapeHtml(LABEL.condition[condition] || condition || '—')}</li>
        <li><strong>Termín:</strong> ${escapeHtml(LABEL.timing[timing] || timing || '—')}</li>
        <li><strong>Vlastnictví:</strong> ${escapeHtml(LABEL.ownership[ownership] || ownership || '—')}</li>
        <li><strong>GDPR souhlas:</strong> ano</li>
        <li><strong>Zdroj:</strong> ${escapeHtml(sourceLabel)}</li>
        <li><strong>Čas odeslání:</strong> ${escapeHtml(ts || new Date().toISOString())}</li>
      </ul>
    `;
    await pd('/notes', { method: 'POST', body: { content: noteHtml, deal_id: dealId, person_id: personId } });

    return jsonResponse({ ok: true, dealId, personId }, 200, cors);
  } catch (err) {
    console.error('leads function error:', err);
    return jsonResponse({
      error: 'Interní chyba — zkuste to prosím znovu nebo zavolejte přímo.',
      debug: String(err && err.message || err).slice(0, 500),
    }, 500, cors);
  }
}
