// Compare Deals — CLAUDE turns a model number + pricing into a sellable listing (their voice).
// Claude is the brain here too. POST { model, msrp, price, condition }
//   -> { title, brand, category, description, specs[], savePct }
// Compare Deals = discount mattress & appliance OUTLET (Lawrenceville + Morrow, GA): SAVE 60-70%
// vs retail, Scratch & Dent = fully functional, cosmetic-only. Env: ANTHROPIC_API_KEY.
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_LISTING_MODEL || 'claude-opus-4-8';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const model = (body.model || '').trim();
    if (!model) return res.status(400).json({ error: 'no model' });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel' });
    const pct = (body.msrp && body.price) ? Math.round((1 - body.price / body.msrp) * 100) : null;

    const system =
      'You write product listings for COMPARE DEALS, a discount mattress & appliance OUTLET in Metro Atlanta (Lawrenceville + Morrow, GA). ' +
      'Voice: confident, plainspoken, value-first — you help everyday families get name-brand appliances for 60-70% off retail. ' +
      'Scratch & Dent ("S&D") means the unit is brand-new and fully functional with only minor cosmetic marks — say that honestly, it is a selling point, not a flaw. ' +
      'NEVER invent exact prices (the price is supplied). Only state specs (capacity, dimensions, features) you are genuinely confident this exact model has — if unsure, keep specs general and factual rather than fabricating numbers. ' +
      'Return ONLY a JSON object, no other text.';

    const user =
      `Create a sellable listing for model "${model}".` +
      (body.condition ? ` Condition: ${body.condition}.` : '') +
      (body.msrp ? ` MSRP $${body.msrp}.` : '') + (body.price ? ` Our price $${body.price}.` : '') +
      (pct ? ` That's about ${pct}% off retail.` : '') +
      '\nJSON shape: {"title": short searchable title with brand + type + a key feature, "brand": manufacturer, "category": product category, "description": 2-3 punchy benefit-led sentences that make someone want it and mention the savings/S&D value honestly, "specs": array of 4-8 short factual spec bullets you are confident about}.';

    const r = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0.5, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Claude: ' + (j.error?.message || r.status) });
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    let d; try { d = JSON.parse(txt); } catch { d = {}; }
    return res.status(200).json({
      title: d.title || '', brand: d.brand || '', category: d.category || '',
      description: d.description || '', specs: Array.isArray(d.specs) ? d.specs : [], savePct: pct,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
};
