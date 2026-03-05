const express = require("express");
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- Paths ----
const TEMPLATE_PATH = path.join(__dirname, "template.svg");
const FONTS_DIR = path.join(__dirname, "fonts");

// Default hero image element id in template.svg is "hero_image".
// Override via env if you rename the element in the SVG.
const HERO_IMAGE_ID = process.env.HERO_IMAGE_ID || "hero_image";

// Your font files (as you described)
const FONT_REGULAR = path.join(FONTS_DIR, "HarmoniaSansProCyr-Regular.otf");
const FONT_SEMIBOLD = path.join(FONTS_DIR, "HarmoniaSansProCyr-SemiBd.otf");

// Load template once on boot
let templateSvg = "";
try {
  templateSvg = fs.readFileSync(TEMPLATE_PATH, "utf8");
} catch (e) {
  console.error("❌ Could not read template.svg:", e);
  process.exit(1);
}

// Validate fonts exist (won’t crash if missing, but you’ll want to know)
for (const p of [FONT_REGULAR, FONT_SEMIBOLD]) {
  if (!fs.existsSync(p)) {
    console.warn(`⚠️ Font file not found: ${p}`);
  }
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
 * Replaces the inner text of an element with id="...".
 * Critically: matches the correct closing tag using </\1> so we never create <text>...</tspan> mismatches.
 * Optionally applies a font-size via inline style.
 */
function replaceTextById(svg, id, newText, opts = {}) {
  const safeText = escapeXml(newText);
  const { fontSizePx } = opts;

  // Capture tag name in group 1, attributes in group 2, inner in group 3
  const re = new RegExp(
    `<([\\w:.-]+)([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)<\\/\\1>`,
    "m"
  );

  if (!re.test(svg)) return svg; // id not found, no-op

  return svg.replace(re, (match, tag, attrs, inner) => {
    let updatedAttrs = attrs;

    if (fontSizePx) {
      // Add/merge style="font-size: XXpx;"
      const styleRe = /\sstyle="([^"]*)"/m;
      if (styleRe.test(updatedAttrs)) {
        updatedAttrs = updatedAttrs.replace(styleRe, (m, styleVal) => {
          const next = styleVal.trim().endsWith(";")
            ? `${styleVal} font-size:${fontSizePx}px;`
            : `${styleVal}; font-size:${fontSizePx}px;`;
          return ` style="${next}"`;
        });
      } else {
        updatedAttrs += ` style="font-size:${fontSizePx}px;"`;
      }
    }

    // Preserve Inkscape-style <tspan> positioning if present.
    // If we replace the whole <text> contents, we can lose x/y on the <tspan>
    // and text may shift or disappear.
    if (/<tspan\b[^>]*>/m.test(inner)) {
      const tspanRe = /(<tspan\b[^>]*>)([\s\S]*?)(<\/tspan>)/m;
      const nextInner = inner.replace(tspanRe, `$1${safeText}$3`);
      return `<${tag}${updatedAttrs}>${nextInner}</${tag}>`;
    }

    return `<${tag}${updatedAttrs}>${safeText}</${tag}>`;
  });
}

function replaceImageHref(svg, id, dataUriOrUrl) {
  const safe = escapeXml(dataUriOrUrl);

  // Replace href="..."
  svg = svg.replace(
    new RegExp(`(<image[^>]*\\bid="${id}"[^>]*\\bhref=")[^"]*(")`, "m"),
    `$1${safe}$2`
  );

  // Replace xlink:href="..."
  svg = svg.replace(
    new RegExp(`(<image[^>]*\\bid="${id}"[^>]*\\bxlink:href=")[^"]*(")`, "m"),
    `$1${safe}$2`
  );

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
      headers: {
        // Some CDNs behave better with a UA
        "User-Agent": "faris-social-renderer/1.0",
      },
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
 * Optional: inject a style block to encourage your SVG to use Harmonia.
 * IMPORTANT: The font-family name must match what your SVG uses.
 * If your SVG uses "Harmonia Sans Pro Cyr", keep that; resvg will match via the loaded font files.
 */
function injectGlobalFontCss(svg) {
  // Add a <style> near the top inside <svg ...>
  // This is safe even if you already set font-family in elements (inline wins).
  const css = `
  <style>
    /* Fallback global font, tweak to match your template naming */
    svg { font-family: "Harmonia Sans Pro Cyr", "HarmoniaSansProCyr", sans-serif; }
  </style>
  `.trim();

  if (/<style[\s>]/m.test(svg)) return svg; // don't double-inject
  return svg.replace(/<svg\b([^>]*)>/m, `<svg$1>\n${css}\n`);
}

// ---- Routes ----
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  try {
    const {
      address_line_1,
      address_line_2,
      agent_name,
      hero_image_url,
    } = req.body || {};

    const missing = [];
    if (!address_line_1) missing.push("address_line_1");
    if (!address_line_2) missing.push("address_line_2");
    if (!agent_name) missing.push("agent_name");
    if (!hero_image_url) missing.push("hero_image_url");

    if (missing.length) {
      return res.status(400).json({
        error: "Missing required fields",
        missing,
      });
    }

    // Start from template
    let svg = templateSvg;

    // (Optional) global css fallback to Harmonia
    svg = injectGlobalFontCss(svg);

    // Basic overflow protection: shrink if long
    const line1 = String(address_line_1);
    const line2 = String(address_line_2);

    const line1FontSize = line1.length > 28 ? 36 : null;
    const line2FontSize = line2.length > 20 ? 28 : null;

    // Replace text by element id
    svg = replaceTextById(svg, "address_line_1", line1, {
      fontSizePx: line1FontSize,
    });
    svg = replaceTextById(svg, "address_line_2", line2, {
      fontSizePx: line2FontSize,
    });
    svg = replaceTextById(svg, "agent_name", agent_name);

    // Inline the hero image so it reliably renders
    const heroDataUri = await fetchAsDataUri(hero_image_url);
    svg = replaceImageHref(svg, HERO_IMAGE_ID, heroDataUri);

    // Render with resvg + local fonts
    const resvg = new Resvg(svg, {
      fitTo: { mode: "original" },
      font: {
        // Load your local brand fonts
        fontFiles: [FONT_REGULAR, FONT_SEMIBOLD].filter((p) =>
          fs.existsSync(p)
        ),
        // Usually false on Render (keeps it deterministic)
        loadSystemFonts: false,
      },
    });

    const pngData = resvg.render().asPng();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");

    // Optional debugging: return SVG in a header (small) or log it if needed
    // res.setHeader("X-Debug-SVG-Length", String(svg.length));

    return res.status(200).send(Buffer.from(pngData));
  } catch (err) {
    console.error("❌ Render error:", err);
    return res.status(500).json({
      error: "Render failed",
      details: String(err?.message || err),
    });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Renderer running on :${PORT}`));