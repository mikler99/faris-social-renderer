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
    // IMPORTANT: use a replacer function, never a replacement string — safeText
    // may contain '$' (e.g. "$1.2M") which String.replace() treats as a
    // backreference pattern, corrupting the XML output.
    if (/<tspan[\s>]/i.test(innerContent)) {
      const newInner = innerContent.replace(
        /(<tspan[^>]*>)[^<]*(<\/tspan>)/,
        (_, open, close) => `${open}${safeText}${close}`
      );
      return `<${tag}${updatedAttrs}>${newInner}</${tag}>`;
    }

    return `<${tag}${updatedAttrs}>${safeText}</${tag}>`;
  });
}

/**
 * Replace href / xlink:href on an <image> element matching id="<id>".
 */
function replaceImageHref(svg, id, dataUriOrUrl) {
  // NOTE: Do NOT escapeXml the href value — data URIs are base64 (safe chars only),
  // and escaping would produce &amp; / &quot; etc. inside the attribute, breaking resvg.
  const href = String(dataUriOrUrl);
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 1. id before href:  <image id="ID" ... href="...">
  svg = svg.replace(
    new RegExp(`(<image[^>]*\\bid="${escapedId}"[^>]*\\bhref=")[^"]*(")`  , "m"),
    `$1${href}$2`
  );
  // 2. id before xlink:href:  <image id="ID" ... xlink:href="...">
  svg = svg.replace(
    new RegExp(`(<image[^>]*\\bid="${escapedId}"[^>]*\\bxlink:href=")[^"]*(")`  , "m"),
    `$1${href}$2`
  );
  // 3. href before id:  <image href="..." ... id="ID">  (Illustrator attr order)
  svg = svg.replace(
    new RegExp(`(<image\\b[^>]*\\bhref=")[^"]*("[^>]*\\bid="${escapedId}"[^>]*/?>)`, "m"),
    `$1${href}$2`
  );
  // 4. xlink:href before id:  <image xlink:href="..." ... id="ID">  (Illustrator with embedded blob)
  svg = svg.replace(
    new RegExp(`(<image\\b[^>]*\\bxlink:href=")[^"]*("[^>]*\\bid="${escapedId}"[^>]*/?>)`, "m"),
    `$1${href}$2`
  );

  // 3. Design Canvas placeholder: <g id="ID" data-field="image">...</g>
  //    Replace the entire group with a proper <image> element.
  //    Attr order varies (id-first or data-field-first), so match both.
  const gRe = new RegExp(
    `<g[^>]*(?:data-field="image"[^>]*id="${escapedId}"|id="${escapedId}"[^>]*data-field="image")[^>]*>[\\s\\S]*?<\\/g>`,
    "m"
  );
  const gMatch = svg.match(gRe);
  if (gMatch) {
    const block = gMatch[0];
    // Pull rect dimensions from the first child <rect>
    const rectM = block.match(/<rect\b[^/]*/);
    const rectStr = rectM ? rectM[0] : block;
    const rx = (rectStr.match(/\bx="([^"]*)"/) || [])[1] || "0";
    const ry = (rectStr.match(/\by="([^"]*)"/) || [])[1] || "0";
    const rw = (rectStr.match(/\bwidth="([^"]*)"/) || [])[1] || "100";
    const rh = (rectStr.match(/\bheight="([^"]*)"/) || [])[1] || "100";
    svg = svg.replace(gRe,
      `<image id="${id}" x="${rx}" y="${ry}" width="${rw}" height="${rh}" ` +
      `href="${href}" preserveAspectRatio="xMidYMid slice"/>`
    );
  }

  return svg;
}

function guessMimeFromUrl(url) {
  const u = String(url).toLowerCase().split("?")[0]; // strip query params
  if (u.endsWith(".png"))              return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".webp"))             return "image/webp";
  if (u.endsWith(".gif"))              return "image/gif";
  return null; // unknown — will fall back to byte sniffing
}

function sniffMimeFromBytes(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  // JPEG: FF D8 FF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
  // GIF: 47 49 46
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  // WebP: 52 49 46 46 .. .. .. .. 57 45 42 50
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "image/jpeg"; // safe default for photo CDNs
}

async function fetchAsDataUri(url, timeoutMs = 15000) {
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

    const arrayBuf = await resp.arrayBuffer();

    // MIME priority: Content-Type header → extension on final URL → extension on original URL → byte sniff
    const contentType =
      resp.headers.get("content-type")?.split(";")[0]?.trim() ||
      guessMimeFromUrl(resp.url) ||   // final URL after redirects (e.g. dl.boxcloud.com/...jpg)
      guessMimeFromUrl(url)       ||  // original URL
      sniffMimeFromBytes(arrayBuf);   // byte-level fallback (handles Box /download URLs)

    const b64 = Buffer.from(arrayBuf).toString("base64");
    return `data:${contentType};base64,${b64}`;
  } finally {
    clearTimeout(t);
  }
}

function injectGlobalFontCss(svg) {
  const css = `<style>svg { font-family: "Harmonia Sans Pro Cyr", "HarmoniaSansProCyr", sans-serif; }</style>`;
  if (/<style[\s>]/m.test(svg)) return svg;
  return svg.replace(/<svg\b([^>]*)>/m, `<svg$1>\n${css}\n`);
}

/**
 * Detect CSS classes with text-align:center and bake text-anchor="middle" onto matching <text> elements.
 * Illustrator exports center-aligned text with translate(cx,cy) but no text-anchor — resvg left-aligns it.
 */
function injectTextAnchor(svg) {
  // Extract <style> content
  const styleMatch = svg.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const cssText = styleMatch ? styleMatch[1] : '';

  // Find class names that declare center alignment
  const centerClasses = new Set();
  for (const [, cls, body] of cssText.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    if (/text-align\s*:\s*center/i.test(body) || /text-anchor\s*:\s*middle/i.test(body)) {
      centerClasses.add(cls);
    }
  }
  if (centerClasses.size === 0) return svg;

  // For each <text> element that uses a center class, add text-anchor="middle" if missing
  return svg.replace(/<text\b([^>]*)>/g, (match, attrs) => {
    if (/text-anchor/.test(attrs)) return match; // already set
    const classMatch = attrs.match(/\bclass="([^"]*)"/);
    if (!classMatch) return match;
    const classes = classMatch[1].split(/\s+/);
    if (!classes.some(c => centerClasses.has(c))) return match;
    return `<text${attrs} text-anchor="middle">`;
  });
}

// ---- Core render logic ----
// Shared by both POST /render and POST /render/:template
/**
 * resvg does not support mix-blend-mode. Illustrator templates use multiply-blend gradient
 * overlays to darken photos (vignettes, text-area backing). Without blend mode support,
 * gradient fills render as raw white-to-black bands creating visible artifacts.
 *
 * Fix:
 *  1. Find all CSS classes that declare mix-blend-mode.
 *  2. For each such class: read its opacity value (default 1).
 *  3. Replace any gradient fill (url(#...)) on that class with fill="none" in CSS.
 *  4. On actual SVG elements using those classes: inject fill="rgba(0,0,0,{opacity})"
 *     directly as an attribute and remove the opacity attribute (baked into rgba).
 *     → This approximates the multiply-darken intent without needing blend mode support.
 *  5. Strip mix-blend-mode from the CSS rules.
 */
function stripMixBlendMode(svg) {
  const styleMatch = svg.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) return svg;
  const cssText = styleMatch[1];

  // Build map: className → { hasBlend, opacity, hasFill }
  // First pass: collect per-class properties
  const classProps = {};
  for (const [, selectors, body] of cssText.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const hasBlend = /mix-blend-mode/i.test(body);
    const opacityMatch = body.match(/(?:^|;)\s*opacity\s*:\s*([\d.]+)/);
    const hasFill = /\bfill\s*:\s*url\(/i.test(body);
    for (const [, cls] of selectors.matchAll(/\.([\w-]+)/g)) {
      if (!classProps[cls]) classProps[cls] = { hasBlend: false, opacity: null, hasFill: false };
      if (hasBlend) classProps[cls].hasBlend = true;
      if (opacityMatch) classProps[cls].opacity = parseFloat(opacityMatch[1]);
      if (hasFill) classProps[cls].hasFill = true;
    }
  }

  const blendClasses = new Set(Object.entries(classProps).filter(([,v]) => v.hasBlend).map(([k]) => k));
  if (blendClasses.size === 0) return svg;

  // Strip mix-blend-mode and gradient fills from CSS
  let fixed = svg.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, body) => {
    let cleaned = body.replace(/\s*mix-blend-mode\s*:[^;}\n]+[;]?/gi, '');
    // Remove gradient fill references from blend classes
    cleaned = cleaned.replace(/([^{}]+)\{([^}]*)\}/g, (rule, selectors, props) => {
      const cls = [...selectors.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
      if (!cls.some(c => blendClasses.has(c))) return rule;
      return rule.replace(/\bfill\s*:\s*url\([^)]*\)\s*;?/gi, '');
    });
    return `<style${attrs}>${cleaned}</style>`;
  });

  // Replace elements: inject fill=rgba(0,0,0,opacity) directly, remove opacity attr
  fixed = fixed.replace(/<(rect|path|circle|ellipse|polygon|polyline)\b([^>]*?)(\/>|>)/g, (match, tag, attrs, close) => {
    const classMatch = attrs.match(/\bclass="([^"]*)"/);
    if (!classMatch) return match;
    const classes = classMatch[1].split(/\s+/);
    if (!classes.some(c => blendClasses.has(c))) return match;

    // Find opacity: element attribute first, then CSS class
    const elOpacityMatch = attrs.match(/\bopacity="([\d.]+)"/);
    let opacity = elOpacityMatch ? parseFloat(elOpacityMatch[1]) : null;
    if (opacity === null) {
      for (const cls of classes) {
        if (classProps[cls]?.opacity !== null && classProps[cls]?.opacity !== undefined) {
          opacity = classProps[cls].opacity; break;
        }
      }
    }
    opacity = opacity ?? 0.25; // sensible default

    const solidFill = `rgba(0,0,0,${opacity})`;

    // Remove existing fill and opacity attrs, then inject solid fill
    let newAttrs = attrs
      .replace(/\bfill="[^"]*"\s*/g, '')
      .replace(/\bopacity="[^"]*"\s*/g, '');
    newAttrs = newAttrs + ` fill="${solidFill}"`;
    return `<${tag}${newAttrs}${close}`;
  });

  return fixed;
}

function fixSingleArgTranslate(svg) {
  return svg.replace(/\btranslate\(\s*([-\d.]+)\s*\)/g, 'translate($1, 0)');
}

async function renderSvgToPng(svg, fields) {
  svg = injectGlobalFontCss(svg);
  svg = injectTextAnchor(svg);
  svg = fixSingleArgTranslate(svg);
  svg = stripMixBlendMode(svg);

  const svgImageIds = detectImageIds(svg);
  const svgAllIds = detectIds(svg);

  // Process all fields from the request body dynamically
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;

    if (svgImageIds.has(key)) {
      // This field maps to an <image> element — fetch and embed as base64
      const dataUri = await fetchAsDataUri(String(value));
      svg = replaceImageHref(svg, key, dataUri);
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