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

/**
 * Normalize Harmonia Sans Pro Cyr font references throughout the SVG.
 *
 * Illustrator exports PostScript names as font-family values:
 *   font-family: HarmoniaSansProCyr-Regular   → family + weight:400
 *   font-family: HarmoniaSansProCyr-SemiBd    → family + weight:600
 *   font-family: HarmoniaSansProCyr-Bold       → family + weight:700
 *
 * resvg (via fontdb) matches by family name + weight, NOT by PostScript name.
 * Without this fix, all weights fall back to the first loaded font (Regular).
 *
 * Strategy:
 *   1. In every CSS rule that sets font-family to a Harmonia PostScript name,
 *      replace it with the canonical family name AND inject font-weight.
 *   2. Also handle font-family set as an attribute on <text>/<tspan> elements.
 *   3. Inject a global fallback so any unspecified elements use the family.
 */
function injectGlobalFontCss(svg) {
  // Map PostScript name → { family, weight }
  const HARMONIA_MAP = {
    'HarmoniaSansProCyr-Regular':  { family: 'Harmonia Sans Pro Cyr', weight: 400 },
    'HarmoniaSansProCyr-SemiBd':   { family: 'Harmonia Sans Pro Cyr', weight: 600 },
    'HarmoniaSansProCyr-Bold':     { family: 'Harmonia Sans Pro Cyr', weight: 700 },
    // Variants without the full suffix
    'HarmoniaSansPro-Regular':     { family: 'Harmonia Sans Pro Cyr', weight: 400 },
    'HarmoniaSansPro-SemiBd':      { family: 'Harmonia Sans Pro Cyr', weight: 600 },
    'HarmoniaSansPro-Bold':        { family: 'Harmonia Sans Pro Cyr', weight: 700 },
  };
  const PS_NAMES = Object.keys(HARMONIA_MAP);
  const PS_PATTERN = PS_NAMES.map(n => n.replace(/-/g, '[-\\s]?')).join('|');
  const PS_RE = new RegExp(`(${PS_PATTERN})`, 'g');

  // 1. Rewrite CSS font-family declarations inside <style> blocks
  svg = svg.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, body) => {
    // Process rule by rule to inject font-weight alongside font-family replacement
    const cleaned = body.replace(
      /([^{}]+)\{([^}]*)\}/g,
      (rule, selectors, props) => {
        // Check if this rule sets a Harmonia PostScript font-family
        const ffMatch = props.match(/font-family\s*:\s*([^;,}\n]+)/i);
        if (!ffMatch) return rule;
        const rawFf = ffMatch[1].trim().replace(/['"]/g, '');
        const entry = HARMONIA_MAP[rawFf] || HARMONIA_MAP[PS_NAMES.find(n => rawFf.replace(/[-\s]/g,'').toLowerCase() === n.replace(/-/g,'').toLowerCase())];
        if (!entry) return rule;

        // Replace font-family, inject font-weight (remove existing font-weight first)
        let newProps = props
          .replace(/\bfont-weight\s*:[^;}\n]+[;]?/gi, '')
          .replace(/font-family\s*:[^;}\n]+/gi,
            `font-family: '${entry.family}'; font-weight: ${entry.weight}`);
        return `${selectors}{${newProps}}`;
      }
    );
    return `<style${attrs}>${cleaned}</style>`;
  });

  // 2. Global fallback: ensure all text defaults to the family
  const fallbackCss = `<style>svg { font-family: 'Harmonia Sans Pro Cyr', sans-serif; font-weight: 400; }</style>`;
  if (!/<style[\s>]/m.test(svg)) {
    svg = svg.replace(/<svg\b([^>]*)>/m, `<svg$1>\n${fallbackCss}\n`);
  } else {
    // Prepend fallback before existing <style>
    svg = svg.replace(/(<svg\b[^>]*>)([\s\S]*?)(<style[\s>])/m, `$1$2${fallbackCss}$3`);
  }

  return svg;
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
 * resvg does not support mix-blend-mode. Illustrator uses multiply-blend gradients to
 * darken photos — white→black linear with multiply = transparent→dark with normal blend.
 *
 * Fix: for each blend-mode overlay class, replace the gradient fill with a new
 * equivalent SVG gradient (no blend mode needed):
 *   - Linear gradient (white→black + multiply) → linearGradient transparent→rgba(0,0,0,op)
 *   - Radial gradient (black→white + multiply) → radialGradient rgba(0,0,0,op)→transparent
 * Both use gradientUnits="objectBoundingBox" so the shape/rotation of the element is preserved.
 * The opacity attribute is removed from each element (baked into the gradient stop colors).
 */
/**
 * Fixes SVGs that were already processed by an older version of Template Studio
 * which used objectBoundingBox for the faris-overlay gradients. Those produce a
 * hard-cutoff line at the rect boundary when rendered by resvg.
 *
 * Detects faris-overlay-* linearGradients with objectBoundingBox and replaces them
 * with per-element userSpaceOnUse gradients with feathering at any rect edge that
 * falls within the visible canvas area.
 */
function fixLegacyOverlayGradients(svg) {
  // Only act if there are legacy faris-overlay gradients with objectBoundingBox
  if (!/<linearGradient[^>]*id="faris-overlay-\d+"[^>]*objectBoundingBox/.test(svg) &&
      !/<radialGradient[^>]*id="faris-overlay-\d+"[^>]*objectBoundingBox/.test(svg)) {
    return svg;
  }

  const vbMatch = svg.match(/viewBox="([^"]*)"/i);
  const vb = vbMatch ? vbMatch[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 1080, 1350];
  const canvasH = vb[3] || 1350;

  // Extract opacity for each faris-overlay gradient from its stop-opacity values
  const gradOpacity = {}; // gradId → effective opacity (max stop-opacity)
  const gradIsRadial = {}; // gradId → boolean
  for (const [, tag, attrs] of svg.matchAll(/<(linear|radial)Gradient([^>]*)objectBoundingBox[\s\S]*?<\/\1Gradient>/gi)) {
    const idM = attrs.match(/id="(faris-overlay-\d+)"/);
    if (!idM) continue;
    const id = idM[1];
    const stops = [...svg.matchAll(new RegExp(`(?<=${id}[\\s\\S]{0,2000}?)stop-opacity="([\\d.]+)"`, 'g'))];
    const maxOp = Math.max(...[...svg.matchAll(
      new RegExp(`<(?:linear|radial)Gradient[^>]*id="${id}"[\\s\\S]*?<\\/(?:linear|radial)Gradient>`, 'g')
    )].flatMap(([block]) =>
      [...block.matchAll(/stop-opacity="([\d.]+)"/g)].map(m => parseFloat(m[1]))
    ), 0.2);
    gradOpacity[id] = maxOp;
    gradIsRadial[id] = tag.toLowerCase() === 'radial';
  }

  if (Object.keys(gradOpacity).length === 0) return svg;

  // Replace each rect that uses a faris-overlay gradient with a new per-element gradient
  let counter = 1000; // start high to avoid collision with any existing IDs
  const newDefs = [];

  svg = svg.replace(/<rect\b([^>]*?)\/>/g, (match, attrs) => {
    const fillM = attrs.match(/\bfill="url\(#(faris-overlay-\d+)\)"/);
    if (!fillM) return match;
    const gradId = fillM[1];
    const opacity = gradOpacity[gradId] ?? 0.2;
    const isRadial = gradIsRadial[gradId] ?? false;

    const rx = parseFloat(attrs.match(/\bx="([^"]*)"/)?.[1] ?? '0');
    const ry = parseFloat(attrs.match(/\by="([^"]*)"/)?.[1] ?? '0');
    const rw = parseFloat(attrs.match(/\bwidth="([^"]*)"/)?.[1] ?? '0');
    const rh = parseFloat(attrs.match(/\bheight="([^"]*)"/)?.[1] ?? '0');

    const newId = `faris-fixed-${++counter}`;

    if (isRadial) {
      const cx = rx + rw / 2, cy = ry + rh / 2, r = Math.max(rw, rh) / 2;
      newDefs.push(
        `<radialGradient id="${newId}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0" stop-color="black" stop-opacity="${opacity}"/>` +
        `<stop offset="1" stop-color="black" stop-opacity="0"/>` +
        `</radialGradient>`
      );
    } else {
      const rectBottom = ry + rh;
      const topAbove = ry < 0;
      const bottomInCanvas = rectBottom < canvasH;
      if (topAbove && bottomInCanvas) {
        // Top vignette: feather at bottom edge to avoid hard cutoff line
        newDefs.push(
          `<linearGradient id="${newId}" x1="0" y1="0" x2="0" y2="${rectBottom}" gradientUnits="userSpaceOnUse">` +
          `<stop offset="0" stop-color="black" stop-opacity="0"/>` +
          `<stop offset="0.75" stop-color="black" stop-opacity="${opacity}"/>` +
          `<stop offset="1" stop-color="black" stop-opacity="0"/>` +
          `</linearGradient>`
        );
      } else {
        const gradY1 = Math.max(ry, 0);
        const gradY2 = Math.min(rectBottom, canvasH);
        newDefs.push(
          `<linearGradient id="${newId}" x1="0" y1="${gradY1}" x2="0" y2="${gradY2}" gradientUnits="userSpaceOnUse">` +
          `<stop offset="0" stop-color="black" stop-opacity="0"/>` +
          `<stop offset="1" stop-color="black" stop-opacity="${opacity}"/>` +
          `</linearGradient>`
        );
      }
    }

    const newAttrs = attrs.replace(/\bfill="url\(#faris-overlay-\d+\)"/, `fill="url(#${newId})"`);
    return `<rect${newAttrs}/>`;
  });

  // Inject new gradients into defs (or create defs if missing)
  if (newDefs.length > 0) {
    if (/<defs[^>]*>/.test(svg)) {
      svg = svg.replace(/(<defs[^>]*>)/, `$1\n${newDefs.join('\n')}`);
    } else {
      svg = svg.replace(/(<svg[^>]*>)/, `$1\n<defs>\n${newDefs.join('\n')}\n</defs>`);
    }
  }

  return svg;
}

function stripMixBlendMode(svg) {
  const styleMatch = svg.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) return svg;
  const cssText = styleMatch[1];

  // Build map: className → { hasBlend, opacity, gradientId }
  const classProps = {};
  for (const [, selectors, body] of cssText.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const hasBlend = /mix-blend-mode/i.test(body);
    const opacityM = body.match(/(?:^|;|\s)opacity\s*:\s*([\d.]+)/);
    const fillM    = body.match(/\bfill\s*:\s*url\(#([\w-]+)\)/i);
    for (const [, cls] of selectors.matchAll(/\.([\w-]+)/g)) {
      if (!classProps[cls]) classProps[cls] = { hasBlend: false, opacity: null, gradientId: null };
      if (hasBlend) classProps[cls].hasBlend = true;
      if (opacityM) classProps[cls].opacity = parseFloat(opacityM[1]);
      if (fillM)    classProps[cls].gradientId = fillM[1];
    }
  }

  const blendClasses = new Set(Object.entries(classProps).filter(([,v]) => v.hasBlend).map(([k]) => k));
  if (blendClasses.size === 0) return svg;

  // Determine gradient type (linear vs radial) for each blend class by inspecting <defs>
  const defsMatch = svg.match(/<defs[^>]*>([\s\S]*?)<\/defs>/i);
  const defsText = defsMatch ? defsMatch[1] : '';

  // Also get viewBox for canvas bounds (needed for gradient clamping)
  const vbMatch = svg.match(/viewBox="([^"]*)"/i);
  const vb = vbMatch ? vbMatch[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 1080, 1350];
  const canvasH = vb[3] || 1350;

  // Build per-gradientId metadata map
  const gradMeta = {}; // gradientId → { isRadial, opacity }
  for (const cls of blendClasses) {
    const { gradientId, opacity } = classProps[cls];
    if (!gradientId || gradMeta[gradientId]) continue;
    const isRadial = new RegExp(`<radialGradient[^>]*\\bid="${gradientId}"`, 'i').test(defsText);
    gradMeta[gradientId] = { isRadial, opacity: opacity ?? 0.25 };
  }

  // We'll generate per-element gradients when we process each element below.
  // Keep a map from element-specific key → new gradient id.
  let overlayCounter = 0;
  const overlayMap = {}; // gradientId → { newId, isRadial, opacity } (generic fallback)

  // Pre-build generic fallbacks in case an element has no parseable geometry
  for (const [gradientId, meta] of Object.entries(gradMeta)) {
    const newId = `faris-overlay-${++overlayCounter}`;
    overlayMap[gradientId] = { newId, ...meta };
  }

  // Inject generic fallback gradients (overridden per-element below where possible)
  if (Object.keys(overlayMap).length > 0) {
    const fallbacks = Object.values(overlayMap).map(({ newId, isRadial, opacity }) => {
      if (isRadial) {
        return `<radialGradient id="${newId}" cx="0.5" cy="0.5" r="0.5" gradientUnits="objectBoundingBox">` +
          `<stop offset="0" stop-color="black" stop-opacity="${opacity}"/>` +
          `<stop offset="1" stop-color="black" stop-opacity="0"/>` +
          `</radialGradient>`;
      } else {
        return `<linearGradient id="${newId}" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">` +
          `<stop offset="0" stop-color="black" stop-opacity="0"/>` +
          `<stop offset="1" stop-color="black" stop-opacity="${opacity}"/>` +
          `</linearGradient>`;
      }
    }).join('\n');
    svg = svg.replace(/(<defs[^>]*>)/, `$1\n${fallbacks}`);
  }

  // Per-element gradient ids map: key = `gradientId:x:y:w:h` → newId
  const elemGradMap = {};

  // Strip mix-blend-mode and gradient fills from CSS, also strip opacity for pure-blend rules
  svg = svg.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, body) => {
    let cleaned = body.replace(/\s*mix-blend-mode\s*:[^;}\n]+[;]?/gi, '');
    // Remove gradient fill and opacity ONLY from rules whose selectors are ALL blend classes
    cleaned = cleaned.replace(/([^{}]+)\{([^}]*)\}/g, (rule, selectors, props) => {
      const ruleCls = [...selectors.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
      if (ruleCls.length === 0) return rule;
      const allBlend = ruleCls.every(c => blendClasses.has(c));
      if (!allBlend) return rule; // mixed rule (e.g. .st2, .st8) — leave opacity intact
      let newProps = props
        .replace(/\bfill\s*:\s*url\([^)]*\)\s*;?/gi, '')
        .replace(/\bopacity\s*:[^;}\n]+[;]?/gi, '');
      return `${selectors}{${newProps}}`;
    });
    return `<style${attrs}>${cleaned}</style>`;
  });

  // Update elements: replace gradient fill attr with a per-element userSpaceOnUse gradient,
  // remove opacity attr. userSpaceOnUse lets us clamp the gradient to visible canvas bounds,
  // preventing the 'box' artifact from off-canvas rects (e.g. top vignette starting at y=-149).
  const newGradientDefs = [];
  svg = svg.replace(/<(rect|path|circle|ellipse|polygon|polyline)\b([^>]*?)(\/>|>)/g, (match, tag, attrs, close) => {
    const classMatch = attrs.match(/\bclass="([^"]*)"/);
    if (!classMatch) return match;
    const classes = classMatch[1].split(/\s+/);
    const blendCls = classes.find(c => blendClasses.has(c));
    if (!blendCls) return match;

    const gradId = classProps[blendCls]?.gradientId;
    const meta = gradId ? gradMeta[gradId] : null;

    let newFill;
    if (meta && tag === 'rect') {
      // Parse rect geometry
      const rx = parseFloat(attrs.match(/\bx="([^"]*)"/)?.[1] ?? '0');
      const ry = parseFloat(attrs.match(/\by="([^"]*)"/)?.[1] ?? '0');
      const rw = parseFloat(attrs.match(/\bwidth="([^"]*)"/)?.[1] ?? '0');
      const rh = parseFloat(attrs.match(/\bheight="([^"]*)"/)?.[1] ?? '0');
      const elemKey = `${gradId}:${rx}:${ry}:${rw}:${rh}`;

      if (!elemGradMap[elemKey]) {
        const elemId = `faris-elem-${++overlayCounter}`;
        elemGradMap[elemKey] = elemId;

        if (meta.isRadial) {
          // Radial: dark center → transparent edge, userSpaceOnUse on element center
          const cx = rx + rw / 2;
          const cy = ry + rh / 2;
          const r  = Math.max(rw, rh) / 2;
          newGradientDefs.push(
            `<radialGradient id="${elemId}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">` +
            `<stop offset="0" stop-color="black" stop-opacity="${meta.opacity}"/>` +
            `<stop offset="1" stop-color="black" stop-opacity="0"/>` +
            `</radialGradient>`
          );
        } else {
          // Linear vignette: transparent→dark, with feathering at any edge that falls
          // within the visible canvas — prevents the hard cutoff line resvg renders.
          //
          // Case A: rect extends above canvas (top vignette, ry < 0, bottom within canvas)
          //   gradient y1=0 (canvas top, transparent) → y2=rectBottom
          //   BUT: the dark end at rectBottom creates a hard line mid-canvas.
          //   Fix: peak at 80% through, fade back to 0 at rectBottom.
          //   This makes the rect boundary always transparent.
          //
          // Case B: rect starts mid-canvas (bottom vignette, ry > 0)
          //   gradient y1=rectTop (transparent) → y2=canvas bottom (or rectBottom if off-canvas)
          //   Top edge is already soft (starts at 0). Bottom edge is at canvas edge — fine.
          //
          const rectBottom = ry + rh;
          const rectTop    = ry;
          const topAbove   = rectTop < 0;           // rect starts above canvas
          const bottomInCanvas = rectBottom < canvasH; // rect ends inside canvas (not off bottom)

          if (topAbove && bottomInCanvas) {
            // Top vignette: feather at both ends — peak in middle, fade to 0 at rect bottom
            const gradY1 = 0;
            const gradY2 = rectBottom;
            const peakOffset = 0.75; // darkest point at 75% through the visible portion
            newGradientDefs.push(
              `<linearGradient id="${elemId}" x1="0" y1="${gradY1}" x2="0" y2="${gradY2}" gradientUnits="userSpaceOnUse">` +
              `<stop offset="0" stop-color="black" stop-opacity="0"/>` +
              `<stop offset="${peakOffset}" stop-color="black" stop-opacity="${meta.opacity}"/>` +
              `<stop offset="1" stop-color="black" stop-opacity="0"/>` +
              `</linearGradient>`
            );
          } else {
            // Bottom vignette or fully off-canvas: simple transparent→dark, soft at top
            const gradY1 = Math.max(rectTop, 0);
            const gradY2 = Math.min(rectBottom, canvasH);
            newGradientDefs.push(
              `<linearGradient id="${elemId}" x1="0" y1="${gradY1}" x2="0" y2="${gradY2}" gradientUnits="userSpaceOnUse">` +
              `<stop offset="0" stop-color="black" stop-opacity="0"/>` +
              `<stop offset="1" stop-color="black" stop-opacity="${meta.opacity}"/>` +
              `</linearGradient>`
            );
          }
        }
      }
      newFill = `url(#${elemGradMap[elemKey]})`;
    } else {
      // Non-rect or no geometry info: fall back to generic gradient
      newFill = gradId && overlayMap[gradId] ? `url(#${overlayMap[gradId].newId})` : 'none';
    }

    let newAttrs = attrs
      .replace(/\bfill="[^"]*"\s*/g, '')
      .replace(/\bopacity="[^"]*"\s*/g, '');
    newAttrs = newAttrs + ` fill="${newFill}"`;
    return `<${tag}${newAttrs}${close}`;
  });

  // Inject the per-element gradients into <defs>
  if (newGradientDefs.length > 0) {
    svg = svg.replace(/(<defs[^>]*>)/, `$1\n${newGradientDefs.join('\n')}`);
  }

  return svg;
}

function fixSingleArgTranslate(svg) {
  return svg.replace(/\btranslate\(\s*([-\d.]+)\s*\)/g, 'translate($1, 0)');
}

async function renderSvgToPng(svg, fields) {
  svg = injectGlobalFontCss(svg);
  svg = injectTextAnchor(svg);
  svg = fixSingleArgTranslate(svg);
  svg = fixLegacyOverlayGradients(svg); // fix old objectBoundingBox faris-overlay gradients
  svg = stripMixBlendMode(svg);         // convert mix-blend-mode for fresh/unprocessed SVGs

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