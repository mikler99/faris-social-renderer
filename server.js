const express = require("express");
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");
// node-fetch v2 (CommonJS) is included in package.json; use it so this works on Node < 18 too.
const fetch = require("node-fetch");

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

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceTextContent(svg, elementId, newText) {
  // Simple text replacement for elements like: <text id="agent_name">...</text>
  // Replaces ANY content between opening/closing tag of the matching id.
  const re = new RegExp(
    `(<text[^>]*id=["']${escapeRegExp(elementId)}["'][^>]*>)([\\s\\S]*?)(</text>)`,
    "i"
  );
  return svg.replace(re, `$1${newText}$3`);
}

function replaceImageHref(svg, elementId, newHref) {
  // Replace href / xlink:href for <image id="..."> so all renderers pick up the same source.
  const id = escapeRegExp(elementId);

  const hrefRe = new RegExp(
    `(<image[^>]*id=["']${id}["'][^>]*\\shref=["'])([^"']+)(["'])`,
    "i"
  );
  const xlinkHrefRe = new RegExp(
    `(<image[^>]*id=["']${id}["'][^>]*\\sxlink:href=["'])([^"']+)(["'])`,
    "i"
  );

  let out = svg.replace(hrefRe, `$1${newHref}$3`);
  out = out.replace(xlinkHrefRe, `$1${newHref}$3`);
  return out;
}

async function fetchAsDataUri(url, timeoutMs = 7000) {
  // Provide a clearer error than "Failed to parse URL" when callers send bad input.
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    const b64 = buf.toString("base64");
    return `data:${contentType};base64,${b64}`;
  } finally {
    clearTimeout(t);
  }
}

async function renderSvgToPng(svgString) {
  const resvg = new Resvg(svgString, {
    // IMPORTANT: Point resvg at your Harmonia font files in the repo
    font: {
      fontFiles: [FONT_REGULAR, FONT_SEMIBOLD],
      loadSystemFonts: false,
    },
    fitTo: {
      mode: "original",
    },
  });

  const rendered = resvg.render();
  const pngBuffer = rendered.asPng();
  return pngBuffer;
}

app.post("/render", async (req, res) => {
  try {
    const {
      address_line_1,
      address_line_2,
      agent_name,
      hero_image_url,
      // Allow common alias keys from different clients/tools.
      background_url,
      background_image_url,
    } = req.body || {};

    const heroUrl = hero_image_url || background_url || background_image_url;

    const missing = [];
    if (!address_line_1) missing.push("address_line_1");
    if (!address_line_2) missing.push("address_line_2");
    if (!agent_name) missing.push("agent_name");
    if (!heroUrl) missing.push("hero_image_url");

    if (missing.length) {
      return res.status(400).json({
        error: "Missing required fields",
        missing,
        hint:
          "Use hero_image_url (preferred). background_url / background_image_url are also accepted now.",
      });
    }

    // Download background image and embed as data URI
    const heroDataUri = await fetchAsDataUri(heroUrl);

    // Apply replacements
    let svg = templateSvg;
    svg = replaceTextContent(svg, "address_line_1", String(address_line_1));
    svg = replaceTextContent(svg, "address_line_2", String(address_line_2));
    svg = replaceTextContent(svg, "agent_name", String(agent_name));
    svg = replaceImageHref(svg, HERO_IMAGE_ID, heroDataUri);

    const png = await renderSvgToPng(svg);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(png);
  } catch (err) {
    console.error("Render failed:", err);
    return res.status(500).json({
      error: "Render failed",
      details: err.message || String(err),
    });
  }
});

app.get("/", (req, res) => {
  res.json({ ok: true, endpoints: ["POST /render"] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Render server listening on :${PORT}`);
});