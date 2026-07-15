// Viral Spark Creative OS — CAROUSEL
// One instruction -> Claude PLANS an N-page Instagram carousel (reads a blog URL if given,
// looks at the reference for style) -> writes N distinct edit prompts -> GPT Image 2 renders
// each page IN PARALLEL. Returns { pages: [{page, role, headline, prompt, b64}, ...] }.
// Needs BOTH env vars: ANTHROPIC_API_KEY and OPENAI_API_KEY.

const PLAN_SYSTEM =
`You are an expert Instagram carousel designer and GPT Image 2 prompt engineer. You are given: (1) a reference graphic showing the brand's EXACT visual style, (2) a topic and/or the text of a blog post, and (3) a number of pages N. Design a cohesive N-page Instagram carousel that turns the topic/blog into a scroll-stopping, on-brand post.

Structure:
- Page 1 = the HOOK / intro — a scroll-stopping title page in the EXACT style of the reference (same layout, colors, fonts, logo, subject treatment).
- Middle pages = the VALUE — the actual tips / causes / steps from the blog, ONE clear idea per page, same brand style.
- Last page = the WRAP-UP / CTA — a closing page (short recap + the brand's OWN call to action). If a CALL-TO-ACTION is provided in the brand kit below, the final page MUST use THAT exact call to action (the brand's real booking/action, address, phone, tagline). NEVER invent a generic CTA like "see a vet" and NEVER copy a CTA from the source blog/topic (it may belong to a different company). The topic/blog is only for the informational content — the CTA always belongs to this brand.

PER-PAGE RULES (apply to EVERY page):
- FINAL SLIDE IS ALWAYS THE CTA: the LAST page is always the call-to-action slide — the brand's own CTA / booking / contact (no swipe cue on it). This is fixed for every carousel and every brand.
- SWIPE CUE ON EVERY OTHER SLIDE: every page EXCEPT that final CTA page MUST include a small, on-brand hand-lettered swipe cue with a little arrow. VARY the wording naturally so it never feels repetitive — e.g. "Swipe →", "Keep swiping →", "Swipe to learn more →", "More inside →", "Next →". The rule is simply that there's always SOME swipe prompt pulling to the next slide; the exact words can change page to page.
- SPEAK AS THE BRAND (not a third party): the client IS the service provider. On ANY page, NEVER tell the reader to "call your vet", "see a vet", "visit a clinic/doctor", or any generic/third-party provider — the brand IS that provider. Reframe in the brand's own first-person voice: "signs it's time to come in", "when to come see us", "walk in and we'll help". (e.g. Ruby is an urgent-care vet → a red-flags page says "Red flags — come see us if…" NOT "call your vet if…".) This applies to informational/value pages too, not just the CTA page.

IF N = 1: ignore the multi-page structure above. Instead design ONE complete, self-contained standalone post — a full graphic with a strong headline, brief supporting copy, the key visual/subject, and a clear CTA — all in the exact brand style of the reference.

IMAGERY SAFETY (critical — OpenAI will REJECT graphic images): NEVER depict blood, feces/stool, vomit, wounds, injuries, surgery, or any graphic/medical imagery on ANY page, even when the topic is medical. The photo subject is ALWAYS a calm, healthy, appealing pet (or a clean, friendly clinic scene). Keep all medical specifics in the TEXT/headline only — the imagery stays gentle, positive, and brand-safe. (e.g. topic "blood in cat stool" → show a healthy, content cat, with the concern conveyed by words, not visuals.)

You may also be given a BRAND KIT (exact hex colors + brand rules/voice/layout do's and don'ts). When present, EVERY page's edit prompt MUST use those EXACT hex colors, obey the layout do's/don'ts (e.g. left-align headlines, never right-align, keep white space), match the voice, and reproduce the brand's signature elements. All pages are PORTRAIT 4:5 vertical Instagram format — state "portrait 4:5 vertical Instagram layout" in each prompt.

For EACH page, write a complete, standalone GPT Image 2 edit prompt that recreates the reference's EXACT layout, color scheme, fonts, logo placement, and design structure, but with that page's specific headline text and subject/photo. Keep every brand element identical across all pages so they read as ONE cohesive set. Spell every word exactly right. Keep headlines short and punchy (a carousel, not paragraphs).

Return ONLY a JSON array (no markdown fences, no preamble), with EXACTLY N items, each of this shape:
{"page": <integer>, "role": "<intro|tip|wrapup>", "headline": "<the main text shown on that page>", "prompt": "<the full GPT Image 2 edit prompt for that page>"}`;

function parseDataUrl(u) {
  const m = /^data:(image\/[a-zA-Z]+);base64,(.*)$/s.exec(u || '');
  if (m) return { media: m[1], b64: m[2] };
  return { media: 'image/png', b64: (u || '').replace(/^data:[^,]*,/, '') };
}

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function buildEditForm(prompt, refImages, size, quality) {
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
  return form;
}

// Renders one image, briefly retrying on 429 rate limits — but ALWAYS returns before the
// serverless time limit (so the client never sees a "Failed to fetch" timeout). If it can't
// finish in budget it throws RATE_LIMIT, and the front-end retries that whole carousel later.
async function genImage(prompt, refImages, size, quality, oKey) {
  const deadline = Date.now() + 90000; // fail fast & return quickly; the front-end owns the longer pacing
  let lastErr = '';
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: 'Bearer ' + oKey },
      body: buildEditForm(prompt, refImages, size, quality)
    });
    if (r.ok) {
      const d = await r.json();
      const b64 = d && d.data && d.data[0] && d.data[0].b64_json;
      if (!b64) throw new Error('no image returned');
      return b64;
    }
    const t = await r.text();
    lastErr = t.slice(0, 300);
    if (r.status !== 429) {
      if (/moderation_blocked|safety system|content_policy/i.test(lastErr))
        throw new Error('MODERATION_BLOCKED: OpenAI blocked this image for graphic/medical content. Soften the visual — avoid depicting blood, stool, vomit, wounds or injuries; describe a calm pet instead.');
      throw new Error('gpt-image-2 render failed: ' + lastErr);
    }
    const waitMs = 12000; // one short in-call retry to smooth over a brief spike
    if (Date.now() + waitMs + 25000 > deadline) throw new Error('RATE_LIMIT'); // bail fast; front-end paces & retries
    await new Promise(res => setTimeout(res, waitMs));
  }
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
    const brief = (body.brief || '').trim();
    const blogUrl = (body.blogUrl || '').trim();
    const brand = body.brand || {};
    const colorsLine = (brand.colors || []).map(c => c.name + ' ' + c.hex).join(', ');
    const st = brand.style;
    const styleLine = st ? ("THIS POST'S EXACT COLOR SCHEME (use these EXACTLY across every page): background " + st.bg + ", primary text " + st.text + ", accent " + st.accent + (st.label ? (" [" + st.label + "]") : "") + "\n") : '';
    const brandBlock = (brand.name ? ('BRAND: ' + brand.name + '\n') : '')
      + styleLine
      + (colorsLine ? ('FULL BRAND PALETTE (for reference): ' + colorsLine + '\n') : '')
      + (brand.guidelines ? ('BRAND GUIDELINES:\n' + brand.guidelines) : '')
      + (brand.cta ? ('\n\nBRAND CALL-TO-ACTION (use on the final/CTA page EXACTLY — overrides any CTA from the source topic/blog):\n' + brand.cta) : '');
    const size = body.size || '1024x768';
    const quality = body.quality || 'high';
    // pages=1 is a valid SINGLE post (GBP / cover). Only fall back to 3 when pages is missing/invalid.
    let pages = parseInt(body.pages, 10); if (!Number.isFinite(pages) || pages < 1) pages = 3; if (pages > 6) pages = 6;
    const refImages = (Array.isArray(body.refImages) && body.refImages.length)
      ? body.refImages.filter(Boolean)
      : (body.refImage ? [body.refImage] : []);
    if (!refImages.length) return res.status(400).json({ error: 'no reference image provided' });
    if (!brief && !blogUrl) return res.status(400).json({ error: 'provide a topic (brief) or a blog URL' });

    // ---------- Optionally read the blog ----------
    let blogText = '';
    if (blogUrl) {
      try {
        const br = await fetch(blogUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViralSparkBot/1.0)' } });
        if (br.ok) blogText = stripHtml(await br.text()).slice(0, 9000);
      } catch (e) { /* proceed without the blog if it can't be fetched */ }
    }

    // ---------- STEP 1: Claude plans the carousel (vision on reference) ----------
    const content = refImages.slice(0, 8).map(u => {
      const p = parseDataUrl(u);
      return { type: 'image', source: { type: 'base64', media_type: p.media, data: p.b64 } };
    });
    content.push({ type: 'text', text:
      'TOPIC / BRIEF: ' + (brief || '(none — use the blog)') +
      (blogText ? ('\n\nBLOG POST CONTENT (source material):\n' + blogText) : '') +
      (brandBlock ? ('\n\nBRAND KIT — every page MUST follow this exactly:\n' + brandBlock) : '') +
      '\n\nTARGET OUTPUT FORMAT: ' + ((body.format || 'portrait 4:5 vertical Instagram carousel page')) + ' — every page must be composed for this exact orientation.' +
      '\n\nDesign a ' + pages + '-page Instagram carousel. Return the JSON array of exactly ' + pages + ' pages.'
    });

    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': aKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 4000, system: PLAN_SYSTEM, messages: [{ role: 'user', content }] })
    });
    if (!cr.ok) { const t = await cr.text(); return res.status(502).json({ error: 'Claude (carousel planner) failed.', detail: t.slice(0, 400) }); }
    const cdata = await cr.json();
    const raw = (cdata.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    let plan;
    try {
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      plan = JSON.parse(raw.slice(s, e + 1));
    } catch (err) {
      return res.status(502).json({ error: 'Could not parse the carousel plan.', detail: raw.slice(0, 400) });
    }
    if (!Array.isArray(plan) || !plan.length) return res.status(502).json({ error: 'Empty carousel plan.' });

    // ---------- STEP 2: render pages IN PARALLEL (Tier 2 = 20 imgs/min gives comfortable headroom) ----------
    // Promise.allSettled KEEPS every page that succeeds even if one fails — no billed page is ever discarded.
    const settled = await Promise.allSettled(plan.map((pg, idx) =>
      genImage(pg.prompt, refImages, size, quality, oKey).then(b64 => ({
        page: pg.page || idx + 1, role: pg.role || '', headline: pg.headline || '', prompt: pg.prompt || '', b64
      }))
    ));
    const results = settled.filter(s => s.status === 'fulfilled').map(s => s.value).sort((a, b) => (a.page || 0) - (b.page || 0));
    const failures = settled.filter(s => s.status === 'rejected').map(s => (s.reason && s.reason.message) || 'render failed');
    if (!results.length) {
      return res.status(502).json({ error: failures[0] || 'no pages rendered' });
    }
    return res.status(200).json({ pages: results, partial: results.length < plan.length, pageError: failures[0] || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
};
