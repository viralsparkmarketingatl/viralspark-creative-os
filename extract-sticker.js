// Compare Deals — CLAUDE reads a barcode price sticker photo into structured data.
// The photo flows through Claude's vision (Anthropic), not a third-party OCR — Claude is the brain.
// POST { image }  where image is a data URL ("data:image/jpeg;base64,…") or an https URL.
//   -> { uniqueId, model, msrp, price, condition, raw }
// Sticker layout: unique number starting with "U" (primary key), "Model #", MSRP, a condition
// flag ("New S&D"), and "Our Price". Env: ANTHROPIC_API_KEY. Optional CLAUDE_VISION_MODEL.
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_VISION_MODEL || 'claude-opus-4-8';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const image = body.image;
    if (!image) return res.status(400).json({ error: 'no image' });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel' });

    // Claude wants base64 (no data-URL prefix) + media_type, OR a url source for https images.
    let source;
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
    if (m) source = { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] };
    else if (/^https?:\/\//i.test(image)) source = { type: 'url', url: image };
    else return res.status(400).json({ error: 'image must be a data URL or https URL' });

    const prompt =
      'You are reading a photo of a retail price sticker from an appliance/mattress outlet. Read it carefully and return ONLY a JSON object with these keys:\n' +
      '- "uniqueId": the unique item number — it ALWAYS starts with the letter U (e.g. "U230001"). This is the primary key; read every character exactly.\n' +
      '- "model": the value after "Model #" (e.g. "HRS290P5FSE"). Read every character exactly — a single wrong character is the wrong product.\n' +
      '- "msrp": the MSRP as a number, no $ or commas (e.g. 1699).\n' +
      '- "price": the "Our Price" value as a number (e.g. 999).\n' +
      '- "condition": any condition flag shown, e.g. "New S&D", "New", "Scratch & Dent". If none shown, "New".\n' +
      'Use null for any field you cannot read with confidence — do NOT guess a model or unique number. Return ONLY the JSON object, no other text.';

    const r = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 400, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'image', source },
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Claude: ' + (j.error?.message || r.status) });
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    // Claude returns clean JSON; strip a stray ```json fence just in case.
    const clean = txt.replace(/^```(?:json)?\s*|\s*```$/g, '');
    let data; try { data = JSON.parse(clean); } catch { data = {}; }
    const num = v => v == null ? null : (typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, '')) || null);
    return res.status(200).json({
      uniqueId: data.uniqueId || null,
      model: data.model || null,
      msrp: num(data.msrp),
      price: num(data.price),
      condition: data.condition || 'New',
      raw: txt,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
};
