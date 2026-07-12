// Viral Spark Creative OS — SMART image (Claude writes the prompt, then GPT Image 2 renders)
// Pipeline: user intent + reference image(s) -> Claude (vision) writes the optimal edit prompt
//           -> OpenAI gpt-image-2 /images/edits -> image. Returns { prompt, b64 }.
// Needs BOTH env vars: ANTHROPIC_API_KEY and OPENAI_API_KEY.

const PROMPT_SYSTEM =
`You are an expert prompt engineer for OpenAI's GPT Image 2 image-EDITS endpoint. Its job is to recreate a reference marketing graphic while changing only specific elements. You are shown the reference image(s) and told what the user wants to convey or change. Write ONE single, ready-to-use edit prompt (plain text — no preamble, no quotes, no markdown, no numbering) that:
- Instructs the model to recreate the reference in the EXACT same layout, color scheme, fonts, logo placement, badges, icons, and overall design structure as the reference image.
- Keeps every brand element, logo, icon, and fixed label byte-for-byte identical to the reference.
- Changes ONLY what the user's intent specifies (e.g. the headline text, the featured photo/subject, a seasonal theme), described precisely and concretely so the model renders it correctly.
- Explicitly tells the model to spell every word exactly right and keep a polished, professional, on-brand look.
IMAGERY SAFETY (critical — OpenAI rejects graphic images): NEVER depict blood, stool, vomit, wounds, injuries, or graphic/medical content, even for medical topics. Always show a calm, healthy, appealing subject; keep any medical specifics in the TEXT only.
If a BRAND KIT is provided (exact hex colors + rules/voice/layout do's and don'ts), the prompt MUST use those exact hex colors, obey the layout do's/don'ts, and match the brand's signature elements.
Keep it tight and concrete (aim for 2-6 sentences). Output ONLY the final edit prompt text.`;

function parseDataUrl(u) {
  const m = /^data:(image\/[a-zA-Z]+);base64,(.*)$/s.exec(u || '');
  if (m) return { media: m[1], b64: m[2] };
  return { media: 'image/png', b64: (u || '').replace(/^data:[^,]*,/, '') };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const aKey = process.env.ANTHROPIC_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!aKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set in Vercel project settings.' });
  if (!oKey) return res.status(500).json({ error: 'OPENAI_API_KEY is not set in Vercel project settings.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const intent = (body.intent || '').trim();
    const brand = body.brand || {};
    const colorsLine = (brand.colors || []).map(c => c.name + ' ' + c.hex).join(', ');
    const st = brand.style;
    const styleLine = st ? ("EXACT COLOR SCHEME (use these EXACTLY): background " + st.bg + ", primary text " + st.text + ", accent " + st.accent + (st.label ? (" [" + st.label + "]") : "") + "\n") : '';
    const brandBlock = (brand.name ? ('BRAND: ' + brand.name + '\n') : '')
      + styleLine
      + (colorsLine ? ('FULL BRAND PALETTE (for reference): ' + colorsLine + '\n') : '')
      + (brand.guidelines ? ('BRAND GUIDELINES:\n' + brand.guidelines) : '')
      + (brand.cta ? ('\n\nBRAND CALL-TO-ACTION (if the graphic includes a call to action, use THIS exactly — never a generic or competitor CTA):\n' + brand.cta) : '');
    const size = body.size || '1024x768';
    const quality = body.quality || 'high';
    const refImages = (Array.isArray(body.refImages) && body.refImages.length)
      ? body.refImages.filter(Boolean)
      : (body.refImage ? [body.refImage] : []);
    if (!intent) return res.status(400).json({ error: 'missing intent (describe what you want)' });
    if (!refImages.length) return res.status(400).json({ error: 'no reference image provided' });

    // ---------- STEP 1: Claude writes the edit prompt (with vision on the reference) ----------
    const content = refImages.slice(0, 8).map(u => {
      const p = parseDataUrl(u);
      return { type: 'image', source: { type: 'base64', media_type: p.media, data: p.b64 } };
    });
    const format = (body.format || '').trim();
    content.push({ type: 'text', text: 'What the user wants to convey / change: ' + intent
      + (brandBlock ? ('\n\nBRAND KIT — the prompt MUST follow this exactly:\n' + brandBlock) : '')
      + (format ? ('\n\nTARGET OUTPUT FORMAT: ' + format + ' — compose the layout to fit this exact orientation. If the reference image is a different shape, ADAPT its style, colors, fonts and elements to this format rather than copying its exact composition; mention the orientation in the prompt.') : '')
      + '\n\nWrite the single best GPT Image 2 edit prompt to achieve this against the reference above.' });

    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': aKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1200,
        system: PROMPT_SYSTEM,
        messages: [{ role: 'user', content }]
      })
    });
    if (!cr.ok) {
      const t = await cr.text();
      return res.status(502).json({ error: 'Claude (prompt writer) failed. Check ANTHROPIC_API_KEY / Anthropic billing.', detail: t.slice(0, 400) });
    }
    const cdata = await cr.json();
    const prompt = (cdata.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!prompt) return res.status(502).json({ error: 'Claude returned no prompt.', detail: JSON.stringify(cdata).slice(0, 300) });

    // ---------- STEP 2: GPT Image 2 renders the prompt against the reference ----------
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('quality', quality);
    refImages.slice(0, 16).forEach((ref, idx) => {
      const p = parseDataUrl(ref);
      const buf = Buffer.from(p.b64, 'base64');
      const ext = p.media.includes('jpeg') ? 'jpg' : (p.media.includes('webp') ? 'webp' : 'png');
      form.append('image[]', new Blob([buf], { type: p.media }), 'reference' + idx + '.' + ext);
    });

    const ir = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + oKey },
      body: form
    });
    if (!ir.ok) {
      const t = await ir.text();
      return res.status(502).json({ error: 'GPT Image 2 render failed (most common cause: OpenAI org not ID-verified).', detail: t.slice(0, 400), prompt });
    }
    const idata = await ir.json();
    const b64 = idata && idata.data && idata.data[0] && idata.data[0].b64_json;
    if (!b64) return res.status(502).json({ error: 'No image returned from edits.', prompt });

    return res.status(200).json({ prompt, b64 });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
};
