const express = require("express");
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

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

/**
 * Replace the inner text of an element that has id="...".
 * IMPORTANT: This regex ensures the closing tag matches the opening tag (prevents </tspan> mismatches).
 * Also optionally injects/overrides font-size on that same element when overflow rules trigger.
 */
function replaceTextById(svg, id, newText) {
  const safe = escapeXml(newText);

  // Simple overflow protection rules (your existing logic)
  let fontSizeAdjustment = "";
  if (id === "address_line_1" && safe.length > 28) {
    fontSizeAdjustment = ' font-size="36"';
  }
  if (id === "address_line_2" && safe.length > 20) {
    fontSizeAdjustment = ' font-size="28"';
  }

  // Capture:
  // 1) prefix "<tag ...id="..."" (without closing ">")
  // 2) the tag name itself (text, tspan, etc.) so we can require the proper closing tag
  // 3) inner content
  // 4) closing tag </sameTag>
  const re = new RegExp(
    `(<([a-zA-Z][\\w:.-]*)[^>]*\\bid="${id}"[^>]*)(>)([\\s\\S]*?)(</\\2\\s*>)`,
    "m"
  );

  // If we match: add the font-size before ">", replace inner content only, keep correct closing tag
  return svg.replace(re, `$1${fontSizeAdjustment}$3${safe}$5`);
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

  return svg;
}

app.post("/render", async (req, res) => {
  try {
    const { address_line_1, address_line_2, agent_name, hero_image_url } =
      req.body || {};

    if (!address_line_1 || !address_line_2 || !agent_name || !hero_image_url) {
      return res.status(400).json({
        error:
          "Missing required fields: address_line_1, address_line_2, agent_name, hero_image_url",
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
      fitTo: { mode: "original" }, // uses the SVG's own size/viewBox
    });

    const pngData = resvg.render().asPng();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(pngData));
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Render failed", details: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Renderer running on :${PORT}`));
