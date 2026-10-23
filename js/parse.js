// Turns a Cloud Vision DOCUMENT_TEXT_DETECTION response into { sku, desc, price, conf }.
// Tag layout (see tests/tag-sample.webp):
//   item number on top (largest text in the top third), description lines below it,
//   "PRICE PER …" + unit price (ignored), "SELL PRICE" + the big sell price, date (ignored).

export const SKU_RE = /^\d{4,8}$/;
const PRICE_TOKEN_RE = /^\d{1,4}\.\d{2}$/;

// Words with digits (model numbers, 4K, 5.1CH) keep their capitals.
export function titleCase(s) {
  return s.split(/\s+/).map(w => /\d/.test(w) ? w.toUpperCase() : w.toLowerCase()
    .replace(/(^|[('"/-])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/'s\b/gi, "'s")).join(' ');
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
    // Typical letter height of the line (the union box is inflated by merged neighbours).
    const hs = l.words.map(w => w.h).sort((a, b) => a - b);
    l.wh = hs[Math.floor(hs.length / 2)];
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

const MAX_DESC_LINES = 4;
const STOP_RE = /PRICE\s*PER|SELL\s*PRICE/i;
const BULLET_RE = /^[•●▪■◦·*]/;

// Feature bullets: start with a bullet glyph, or are mostly lowercase (descriptions are printed in capitals).
function isFeatureLine(l) {
  if (BULLET_RE.test(l.text)) return true;
  const letters = l.text.replace(/[^A-Za-z]/g, '');
  const lower = l.text.replace(/[^a-z]/g, '').length;
  return letters.length >= 4 && lower / letters.length > 0.3;
}

export function parseTag(resp, imageHeight) {
  const ws = words(resp);
  const ls = lines(ws);
  const bottom = imageHeight || Math.max(0, ...ws.map(w => w.y1));
  const top = imageHeight ? 0 : Math.min(...ws.map(w => w.y0));

  // Item number: the tallest 4–8 digit token in the top half (fine print above the tag can hold digits too).
  const skuCands = ws.filter(w => SKU_RE.test(w.text));
  const topHalf = skuCands.filter(w => w.cy < top + (bottom - top) / 2);
  const skuWord = (topHalf.length ? topHalf : skuCands).sort((a, b) => b.h - a.h || a.y0 - b.y0)[0];
  const skuLine = skuWord ? ls.find(l => l.words.includes(skuWord)) : null;

  // Description: the run of large-type lines right under the item number. It ends at the first
  // bullet / feature line (smaller or mixed-case text), "PRICE PER …", "SELL PRICE", or the big price.
  const startIdx = skuLine ? ls.indexOf(skuLine) + 1 : 0;
  const descLines = [];
  let refH = 0;
  for (let i = startIdx; i < ls.length && descLines.length < MAX_DESC_LINES; i++) {
    const l = ls[i], prev = descLines[descLines.length - 1];
    if (STOP_RE.test(l.text) || isFeatureLine(l)) break;
    if (mergePriceTokens(l).some(p => p.h > l.wh * 1.3)) break;
    if (refH && l.wh < refH * 0.7) break;
    if (prev && l.y0 - prev.y1 > Math.max(refH, l.wh) * 1.2) break;
    descLines.push(l);
    refH = Math.max(refH, l.wh);
  }
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
