// Turns a Cloud Vision DOCUMENT_TEXT_DETECTION response into { sku, desc, price, conf }.
// Tag layout (see tests/tag-sample.webp):
//   item number on top (largest text in the top third), description lines below it,
//   "PRICE PER …" + unit price (ignored), "SELL PRICE" + the big sell price, date (ignored).

export const SKU_RE = /^\d{4,8}$/;
const PRICE_TOKEN_RE = /^\d{1,4}\.\d{2}$/;

export function titleCase(s) {
  return s.toLowerCase()
    .replace(/(^|\s|')\S/g, m => m.toUpperCase())
    .replace(/'S\b/g, "'s");
}

function box(vertices = []) {
  const xs = vertices.map(v => v.x || 0), ys = vertices.map(v => v.y || 0);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x0, x1, y0, y1, h: y1 - y0, cy: (y0 + y1) / 2 };
}

function wordConf(w) {
  if (typeof w.confidence === 'number') return w.confidence;
  const cs = (w.symbols || []).map(s => s.confidence).filter(c => typeof c === 'number');
  return cs.length ? Math.min(...cs) : 1;
}

// Flatten pages → blocks → paragraphs → words.
export function words(resp) {
  const out = [];
  const pages = resp?.fullTextAnnotation?.pages || [];
  for (const p of pages) for (const b of p.blocks || []) for (const para of b.paragraphs || []) {
    for (const w of para.words || []) {
      const text = (w.symbols || []).map(s => s.text).join('');
      if (!text) continue;
      out.push({ text, conf: wordConf(w), ...box(w.boundingBox?.vertices) });
    }
  }
  return out;
}

// Group words into visual lines by vertical overlap (so a low "." still joins "19" and "99"),
// each sorted left → right.
export function lines(ws) {
  const sorted = [...ws].sort((a, b) => a.cy - b.cy);
  const out = [];
  for (const w of sorted) {
    const line = out.find(l => Math.min(l.y1, w.y1) - Math.max(l.y0, w.y0) >= 0.5 * Math.min(l.h, w.h));
    if (line) {
      line.words.push(w);
      line.y0 = Math.min(line.y0, w.y0); line.y1 = Math.max(line.y1, w.y1);
      line.h = line.y1 - line.y0; line.cy = (line.y0 + line.y1) / 2;
    } else out.push({ y0: w.y0, y1: w.y1, cy: w.cy, h: w.h, words: [w] });
  }
  for (const l of out) {
    l.words.sort((a, b) => a.x0 - b.x0);
    l.text = l.words.map(w => w.text).join(' ');
  }
  return out.sort((a, b) => a.cy - b.cy);
}

// Vision may split "19.99" into "19" "." "99" — merge up to 3 adjacent tokens that form a price.
function mergePriceTokens(line) {
  const ws = line.words, out = [];
  for (let i = 0; i < ws.length; i++) {
    for (let n = 3; n >= 2; n--) {
      const run = ws.slice(i, i + n);
      if (run.length < n) continue;
      const text = run.map(w => w.text).join('').replace(/^\$/, '');
      if (PRICE_TOKEN_RE.test(text)) {
        out.push({
          text, conf: Math.min(...run.map(w => w.conf)),
          x0: Math.min(...run.map(w => w.x0)), x1: Math.max(...run.map(w => w.x1)),
          y0: Math.min(...run.map(w => w.y0)), y1: Math.max(...run.map(w => w.y1)),
          h: Math.max(...run.map(w => w.h)),
        });
      }
    }
    const t = ws[i].text.replace(/^\$/, '');
    if (PRICE_TOKEN_RE.test(t)) out.push({ ...ws[i], text: t });
  }
  return out;
}

const pct = c => Math.round(c * 100);

export function parseTag(resp, imageHeight) {
  const ws = words(resp);
  const ls = lines(ws);
  const bottom = imageHeight || Math.max(0, ...ws.map(w => w.y1));
  const top = imageHeight ? 0 : Math.min(...ws.map(w => w.y0));

  // Item number: the 4–8 digit token with the smallest y, preferring the top third.
  const skuCands = ws.filter(w => SKU_RE.test(w.text)).sort((a, b) => a.y0 - b.y0);
  const skuWord = skuCands.find(w => w.cy < top + (bottom - top) / 3) || skuCands[0];
  const skuLine = skuWord ? ls.find(l => l.words.includes(skuWord)) : null;

  // Description: lines between the item number and "PRICE PER …" (or "SELL PRICE" / a price line as fallback).
  const startIdx = skuLine ? ls.indexOf(skuLine) + 1 : 0;
  let endIdx = ls.findIndex((l, i) => i >= startIdx && /PRICE\s*PER/i.test(l.text));
  if (endIdx < 0) endIdx = ls.findIndex((l, i) => i >= startIdx && (/SELL/i.test(l.text) || mergePriceTokens(l).length));
  if (endIdx < 0) endIdx = ls.length;
  const descLines = ls.slice(startIdx, endIdx);
  const descWords = descLines.flatMap(l => l.words);
  const desc = titleCase(descLines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim());

  // Price: the price-shaped token with the tallest bounding box.
  const priceCands = ls.flatMap(mergePriceTokens).sort((a, b) => b.h - a.h);
  const priceWord = priceCands[0];

  return {
    sku: skuWord ? skuWord.text : '',
    desc,
    price: priceWord ? priceWord.text : '',
    conf: {
      sku: skuWord ? pct(skuWord.conf) : 0,
      desc: descWords.length ? pct(Math.min(...descWords.map(w => w.conf))) : 0,
      price: priceWord ? pct(priceWord.conf) : 0,
    },
  };
}

// Which field (if any) should hold the scan for review. Pattern failures count as 0%.
export function weakestField(parsed, threshold) {
  const fails = {
    sku: SKU_RE.test(parsed.sku) ? parsed.conf.sku : 0,
    desc: parsed.desc ? parsed.conf.desc : 0,
    price: /^\d+(\.\d{2})?$/.test(parsed.price) ? parsed.conf.price : 0,
  };
  const [field, conf] = Object.entries(fails).sort((a, b) => a[1] - b[1])[0];
  return conf < threshold ? { field, conf } : null;
}
