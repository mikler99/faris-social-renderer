const express = require("express");
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- CORS — allow browser requests from any origin ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---- Paths ----
const TEMPLATES_DIR = path.join(__dirname, "templates");
const FONTS_DIR = path.join(__dirname, "fonts");

// Font files
const FONT_REGULAR  = path.join(FONTS_DIR, "HarmoniaSansProCyr-Regular.otf");
const FONT_SEMIBOLD = path.join(FONTS_DIR, "HarmoniaSansProCyr-SemiBd.otf");
const FONT_BOLD     = path.join(FONTS_DIR, "HarmoniaSansProCyr-Bold.otf");

// Validate fonts exist on boot
for (const p of [FONT_REGULAR, FONT_SEMIBOLD, FONT_BOLD]) {
  if (!fs.existsSync(p)) {
    console.warn(`⚠️  Font file not found: ${p}`);
  }
}

// ---- Template loading ----
// Supports /render (default template.svg) and /render/:template (templates/<name>.svg)
// Templates are loaded fresh per request so updates don't need a redeploy.
function loadTemplate(name = "template") {
  // Try templates/<name>.svg first, then fall back to <name>.svg in root
  const candidates = [
    path.join(TEMPLATES_DIR, `${name}.svg`),
    path.join(__dirname, `${name}.svg`),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { svg: fs.readFileSync(p, "utf8"), resolvedPath: p };
    }
  }

  throw new Error(`Template not found: "${name}". Looked in: ${candidates.join(", ")}`);
}

// ---- Helpers ----
function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Detect all element IDs present in the SVG.
 * Returns a Set of id strings.
 */
function detectIds(svg) {
  const ids = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

/**
 * Detect all <image> element IDs in the SVG.
 */
function detectImageIds(svg) {
  const ids = new Set();
  const re = /<image[^>]*\bid="([^"]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(svg)) !== null) { ids.add(m[1]); }
  // Design Canvas placeholders: <g data-field="image" id="..."> (attr order varies)
  const re2 = /<g\b[^>]*\bdata-field="image"[^>]*>/g;
  while ((m = re2.exec(svg)) !== null) {
    const idM = m[0].match(/\bid="([^"]+)"/);
    if (idM) ids.add(idM[1]);
  }
  return ids;
}

/**
 * Replace inner content of any element matching id="<id>".
 * Handles nested tspan (Illustrator) by replacing the full inner content.
 * Optionally shrinks font-size if text is long (auto-fit).
 */
function replaceTextById(svg, id, newText, opts = {}) {
  const safeText = escapeXml(newText);
  const { autoFit = true } = opts;

  const re = new RegExp(
    `(<([\\w:.-]+)([^>]*\\bid="${id}"[^>]*)>)([\\s\\S]*?)(<\\/\\2>)`,
    "m"
  );

  if (!re.test(svg)) return svg;

  return svg.replace(re, (match, openTag, tag, attrs, innerContent, closeTag) => {
    let updatedAttrs = attrs;

    // Auto-fit: proportionally shrink font-size for long strings.
    // Uses a scale factor relative to existing size — works regardless of unit scale.
    if (autoFit) {
      const len = String(newText).length;
      let factor = null;
      if (len > 40) factor = 0.60;
      else if (len > 28) factor = 0.75;
      else if (len > 20) factor = 0.85;

      if (factor !== null) {
        updatedAttrs = updatedAttrs.replace(
          /(\bstyle\s*=\s*")([^"]*font-size\s*:\s*)([\d.]+)(px|pt|em|rem)([^"]*")/,
          (m, pre, fsPre, num, unit, post) => {
            return `${pre}${fsPre}${(parseFloat(num) * factor).toFixed(3)}${unit}${post}`;
          }
        );
      }
    }

    // Preserve tspan structure: if there is a tspan child, only replace its
    // text content so its x/y positioning attributes are kept intact.
    if (/<tspan[\s>]/i.test(innerContent)) {
      const newInner = innerContent.replace(
        /(<tspan[^>]*>)[^<]*(<\/tspan>)/,
        `$1${safeText}$2`
      );
      return `<${tag}${updatedAttrs}>${newInner}</${tag}>`;
    }

    return `<${tag}${updatedAttrs}>${safeText}</${tag}>`;
  });
}

/**
 * Replace href / xlink:href on an <image> element matching id="<id>".
 */
function applyFocalPoint(tag, focalPct, canvasW) {
  // Case A: image has transform="translate(tx ty) scale(s)"
  const transformMatch = tag.match(/\btransform="translate\(\s*([\d.+-]+)\s+([\d.+-]+)\s*\)\s*scale\(\s*([\d.]+)\s*\)"/);
  if (transformMatch) {
    const [fullTransform, txStr, tyStr, scaleStr] = transformMatch;
    const tx = parseFloat(txStr);
    const ty = parseFloat(tyStr);
    const scale = parseFloat(scaleStr);

    // Get original image dimensions from width= and height= attributes
    const wMatch = tag.match(/\bwidth="([\d.]+)"/);
    const hMatch = tag.match(/\bheight="([\d.]+)"/);
    if (!wMatch || !hMatch) return tag; // can't calculate, leave as-is

    const imgW = parseFloat(wMatch[1]);
    const scaledW = imgW * scale;
    const overflow = scaledW - canvasW;

    if (overflow <= 0) return tag; // image fits — no cropping needed

    // Where is the focal point in scaled SVG units?
    const focalScaled = imgW * (focalPct / 100) * scale;
    // We want focalScaled to appear at canvas centre
    let newTx = (canvasW / 2) - focalScaled;
    // Clamp: 0 = left-aligned, -(overflow) = right-aligned
    newTx = Math.min(0, Math.max(-overflow, newTx));

    console.log(`  → translate X: ${tx.toFixed(2)} → ${newTx.toFixed(2)} (focal ${focalPct}%)`);

    const newTransform = `transform="translate(${newTx.toFixed(2)} ${ty}) scale(${scale})"`;
    return tag.replace(fullTransform, newTransform);
  }

  // Case B: image uses x/y/width/height — adjust preserveAspectRatio
  let par;
  if (focalPct < 38)      par = "xMinYMid slice";
  else if (focalPct > 62) par = "xMaxYMid slice";
  else                     par = "xMidYMid slice";

  if (/\bpreserveAspectRatio=/.test(tag)) {
    return tag.replace(/\bpreserveAspectRatio="[^"]*"/, `preserveAspectRatio="${par}"`);
  } else {
    return tag.replace(/(\/?>)$/, ` preserveAspectRatio="${par}"$1`);
  }
}


function injectGlobalFontCss(svg) {
  const css = `<style>svg { font-family: "Harmonia Sans Pro Cyr", "HarmoniaSansProCyr", sans-serif; }</style>`;
  if (/<style[\s>]/m.test(svg)) return svg;
  return svg.replace(/<svg\b([^>]*)>/m, `<svg$1>\n${css}\n`);
}

// ---- Core render logic ----

function replaceImageHref(svg, id, dataUriOrUrl, focalPct = 50, canvasW = 1080) {
  // NOTE: Do NOT escapeXml the href value — data URIs are base64 (safe chars only),
  // and escaping would produce &amp; / &quot; etc. inside the attribute, breaking resvg.
  const href = String(dataUriOrUrl);
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Apply new href + focal-point-aware crop to a matched <image> tag string.
  // Works regardless of attribute order — xlink:href/href may appear before or after id=.
  function applyToTag(tag) {
    // Replace xlink:href first (before plain href, to avoid double-match)
    tag = tag.replace(/\bxlink:href="[^"]*"/, `xlink:href="${href}"`);
    // Plain href — negative lookbehind excludes xlink:href
    tag = tag.replace(/(?<!xlink:)\bhref="[^"]*"/, `href="${href}"`);
    // Apply focal-point crop (adjusts transform translate or preserveAspectRatio)
    tag = applyFocalPoint(tag, focalPct, canvasW);
    return tag;
  }

  // 1 & 2: Match the WHOLE <image> tag by id, regardless of where id sits among attributes.
  //         This fixes attribute-order bugs (e.g. xlink:href before id= in Illustrator SVGs).
  svg = svg.replace(
    new RegExp(`<image\\b[^>]*\\bid="${escapedId}"[^>]*/?>\\n?`, "m"),
    applyToTag
  );

  // 3. Design Canvas placeholder: <g id="ID" data-field="image">...</g>
  const gRe = new RegExp(
    `<g[^>]*(?:data-field="image"[^>]*id="${escapedId}"|id="${escapedId}"[^>]*data-field="image")[^>]*>[\\s\\S]*?<\\/g>`,
    "m"
  );
  const gMatch = svg.match(gRe);
  if (gMatch) {
    const block = gMatch[0];
    const rectM = block.match(/<rect\b[^/]*/);
    const rectStr = rectM ? rectM[0] : block;
    const rx = (rectStr.match(/\bx="([^"]*)"/) || [])[1] || "0";
    const ry = (rectStr.match(/\by="([^"]*)"/) || [])[1] || "0";
    const rw = (rectStr.match(/\bwidth="([^"]*)"/) || [])[1] || "100";
    const rh = (rectStr.match(/\bheight="([^"]*)"/) || [])[1] || "100";
    let newTag = `<image id="${id}" x="${rx}" y="${ry}" width="${rw}" height="${rh}" href="${href}"/>`;
    newTag = applyFocalPoint(newTag, focalPct, canvasW);
    svg = svg.replace(gRe, newTag);
  }

  return svg;
}

function guessMimeFromUrl(url) {
  const u = String(url).toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

async function fetchAsDataUri(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "faris-social-renderer/1.0" },
    });

    if (!resp.ok) {
      throw new Error(`Image fetch failed: ${resp.status} ${resp.statusText}`);
    }

    const contentType =
      resp.headers.get("content-type")?.split(";")[0]?.trim() ||
      guessMimeFromUrl(url);

    const arrayBuf = await resp.arrayBuffer();
    const b64 = Buffer.from(arrayBuf).toString("base64");
    return `data:${contentType};base64,${b64}`;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Use Claude Vision to detect the horizontal focal point of the main subject
 * (building, house, condo) in a real estate photo.
 *
 * Returns a preserveAspectRatio value:
 *   xMinYMid slice  — subject is on the left  (focal point < 38%)
 *   xMidYMid slice  — subject is centred       (focal point 38–62%)
 *   xMaxYMid slice  — subject is on the right  (focal point > 62%)
 *
 * Falls back to "xMidYMid slice" on any error so rendering always completes.
 */
async function detectSubjectFocalPoint(dataUri) {
  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      console.warn("⚠️  ANTHROPIC_API_KEY not set — skipping focal point detection, using center crop");
      return 50;
    }

    // Extract base64 and media type from data URI
    const match = dataUri.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
    if (!match) return 50;
    const [, mediaType, b64] = match;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: b64 },
            },
            {
              type: "text",
              text: "This is a real estate photo. Where is the horizontal center of the main building or structure? Reply with ONLY a single integer: the percentage from the left edge (0-100). No explanation.",
            },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      console.warn(`⚠️  Claude Vision API error ${resp.status} — using center crop`);
      return 50;
    }
    const json = await resp.json();
    const raw = json?.content?.[0]?.text?.trim() ?? "";
    const pct = parseInt(raw, 10);
    if (isNaN(pct)) {
      console.warn(`⚠️  Unexpected focal point response: "${raw}" — using center crop`);
      return 50;
    }

    console.log(`🏠 Focal point detected: ${pct}% from left`);
    return pct;
  } catch (err) {
    console.warn("⚠️  Focal point detection failed (using center crop):", err.message);
    return 50;
  }
}

/**
 * Given an <image> tag string that uses transform="translate(tx ty) scale(s)",
 * adjust the translate X so the focal point (0–100% of image width) is centred
 * in the SVG canvas. Clamps to avoid showing empty space on either side.
 *
 * Also handles the simpler preserveAspectRatio case for images without a transform.
 */
// Shared by both POST /render and POST /render/:template
async function renderSvgToPng(svg, fields) {
  svg = injectGlobalFontCss(svg);

  const svgImageIds = detectImageIds(svg);
  const svgAllIds = detectIds(svg);

  // Extract canvas width from the SVG viewBox for focal point calculations
  const vbMatch = svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/);
  const canvasW = vbMatch ? parseFloat(vbMatch[1]) : 1080;

  // Process all fields from the request body dynamically
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;

    if (svgImageIds.has(key)) {
      // This field maps to an <image> element — fetch, analyse focal point, embed as base64
      const dataUri = await fetchAsDataUri(String(value));
      const focalPct = await detectSubjectFocalPoint(dataUri);
      svg = replaceImageHref(svg, key, dataUri, focalPct, canvasW);
    } else if (svgAllIds.has(key)) {
      // Text or other element — replace inner content
      svg = replaceTextById(svg, key, String(value));
    }
    // If the key doesn't match any ID in the SVG, silently ignore it
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      fontFiles: [FONT_REGULAR, FONT_SEMIBOLD, FONT_BOLD].filter((p) => fs.existsSync(p)),
      loadSystemFonts: false,
    },
  });

  return resvg.render().asPng();
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * GET /templates
 * Lists all available .svg files across root and templates/ directory.
 * Useful for the visual studio and debugging.
 */
app.get("/templates", (req, res) => {
  const found = [];

  // Root-level template.svg (legacy)
  const rootTemplate = path.join(__dirname, "template.svg");
  if (fs.existsSync(rootTemplate)) {
    found.push({ name: "template", path: "template.svg" });
  }

  // templates/ directory
  if (fs.existsSync(TEMPLATES_DIR)) {
    const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".svg"));
    for (const f of files) {
      found.push({ name: path.basename(f, ".svg"), path: `templates/${f}` });
    }
  }

  res.json({ templates: found });
});

/**
 * GET /templates/:name/fields
 * Returns all IDs detected in a template SVG.
 * Powers the visual studio field detection.
 */
app.get("/templates/:name/fields", (req, res) => {
  try {
    const { svg } = loadTemplate(req.params.name);
    const imageIds = detectImageIds(svg);
    const allIds = detectIds(svg);

    // Exclude purely auto-generated structural IDs from Inkscape/Illustrator
    const AUTO_STRUCT = /^(svg\d|defs\d?|namedview\d?|layer\d|g\d+|clipPath\d|mask\d|pattern\d|metadata\d)$/i;
    const fields = [...allIds]
      .filter((id) => !AUTO_STRUCT.test(id))
      .map((id) => ({
        id,
        type: imageIds.has(id) ? "image_url" : "text",
      }));

    res.json({ template: req.params.name, fields });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /render-inline
 * Accepts raw SVG + fields in the request body. No file lookup needed.
 * Powers the Template Studio test-render flow — no git push required.
 *
 * Body: { svg: "<svg>...</svg>", fields: { id: value, ... } }
 */
app.post("/render-inline", async (req, res) => {
  try {
    const { svg, fields = {} } = req.body || {};
    if (!svg || typeof svg !== "string") {
      return res.status(400).json({ error: "Missing or invalid `svg` field in request body." });
    }
    const pngData = await renderSvgToPng(svg, fields);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(pngData));
  } catch (err) {
    console.error("❌ Inline render error:", err);
    return res.status(500).json({ error: "Render failed", details: String(err?.message || err) });
  }
});

/**
 * POST /render
 * Legacy route — uses template.svg in root. Fully backwards compatible.
 * Body: any key/value pairs where keys match element IDs in the SVG.
 */
app.post("/render", async (req, res) => {
  try {
    const { svg } = loadTemplate("template");
    const pngData = await renderSvgToPng(svg, req.body || {});

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(pngData));
  } catch (err) {
    console.error("❌ Render error:", err);
    return res.status(500).json({ error: "Render failed", details: String(err?.message || err) });
  }
});

/**
 * POST /render/:template
 * Dynamic route — renders any named template from the templates/ directory.
 * Body: any key/value pairs where keys match element IDs in the SVG.
 *
 * Example: POST /render/just_sold  { "address_line_1": "...", "hero_image": "..." }
 * Example: POST /render/open_house { "date": "...", "address_line_1": "..." }
 */
app.post("/render/:template", async (req, res) => {
  try {
    const { svg } = loadTemplate(req.params.template);
    const pngData = await renderSvgToPng(svg, req.body || {});

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(pngData));
  } catch (err) {
    console.error("❌ Render error:", err);
    return res.status(500).json({ error: "Render failed", details: String(err?.message || err) });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Renderer running on :${PORT}`));