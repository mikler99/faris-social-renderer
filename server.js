const express = require("express");
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

// Node 18+ has fetch built-in. If you're on older Node, use node-fetch.
const app = express();
app.use(express.json({ limit: "10mb" }));

const TEMPLATE_PATH = path.join(__dirname, "template.svg");
const templateSvg = fs.readFileSync(TEMPLATE_PATH, "utf8");

// Minimal XML escape for text injection
function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Replace the text content of an element by id="..."
function replaceTextById(svg, id, newText) {
  const safe = escapeXml(newText);

  let fontSizeAdjustment = "";

  // Simple overflow protection rules
  if (id === "address_line_1" && safe.length > 28) {
    fontSizeAdjustment = ' font-size="36"';
  }

  if (id === "address_line_2" && safe.length > 20) {
    fontSizeAdjustment = ' font-size="28"';
  }

  const re = new RegExp(
    `(<[^>]*\\bid="${id}"[^>]*)(>)([\\s\\S]*?)(</[^>]+>)`,
    "m"
  );

  return svg.replace(re, `$1${fontSizeAdjustment}$2${safe}$4`);
}

// Replace image href/xlink:href for <image id="hero_image" ...>
function replaceImageHref(svg, id, url) {
  const safeUrl = escapeXml(url);

  // Replace href="..." if present
  svg = svg.replace(
    new RegExp(`(<image[^>]*\\bid="${id}"[^>]*\\bhref=")[^"]*(")`, "m"),
    `$1${safeUrl}$2`
  );

  // Replace xlink:href="..." if present
  svg = svg.replace(
    new RegExp(`(<image[^>]*\\bid="${id}"[^>]*\\bxlink:href=")[^"]*(")`, "m"),
    `$1${safeUrl}$2`
  );

  // If neither exists (rare), you can inject href attr, but usually not needed.
  return svg;
}

app.post("/render", async (req, res) => {
  try {
    const {
      address_line_1,
      address_line_2,
      agent_name,
      hero_image_url
    } = req.body || {};

    if (!address_line_1 || !address_line_2 || !agent_name || !hero_image_url) {
      return res.status(400).json({
        error: "Missing required fields: address_line_1, address_line_2, agent_name, hero_image_url"
      });
    }

    // Build injected SVG
    let svg = templateSvg;
    svg = replaceTextById(svg, "address_line_1", address_line_1);
    svg = replaceTextById(svg, "address_line_2", address_line_2);
    svg = replaceTextById(svg, "agent_name", agent_name);
    svg = replaceImageHref(svg, "hero_image", hero_image_url);

    // Render with resvg
    const resvg = new Resvg(svg, {
      fitTo: { mode: "original" } // uses the SVG's own size/viewBox
    });

    const pngData = resvg.render().asPng();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(pngData));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Render failed", details: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Renderer running on :${PORT}`));
