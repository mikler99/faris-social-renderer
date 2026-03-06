const express = require("express");
const cors = require("cors");
const { Resvg } = require("@resvg/resvg-js");
const sharp = require("sharp");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/**
 * Fetch a remote image and return a data URI (data:image/...;base64,...)
 * - Validates Content-Type is image/*
 * - Adds a timeout so requests don't hang
 */
async function fetchAsDataUri(url, { timeoutMs = 8000 } = {}) {
  if (!url || typeof url !== "string") {
    throw new Error("background_url is required and must be a string");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(`Invalid background_url: ${String(e.message || e)}`);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "svg-renderer/1.0 (+resvg)",
        Accept: "image/*,*/*;q=0.8",
      },
    });
  } catch (e) {
    clearTimeout(t);
    const msg =
      e && e.name === "AbortError"
        ? `Fetch timed out after ${timeoutMs}ms`
        : String(e.message || e);
    throw new Error(`Failed to fetch background_url: ${msg}`);
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch background_url: HTTP ${res.status}`);
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `background_url did not return an image. content-type="${contentType || "unknown"}". ` +
        `Use a direct image URL (one that loads the JPG/PNG itself), not a preview/share page.`
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString("base64");
  return `data:${contentType.split(";")[0]};base64,${base64}`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function replaceImageHref(svgString, elementId, hrefValue) {
  const safeHref = escapeXml(hrefValue);

  // xlink:href
  let out = svgString.replace(
    new RegExp(
      `(<image[^>]*\\bid=["']${elementId}["'][^>]*\\bxlink:href=["'])[\\s\\S]*?(["'][^>]*>)`,
      "i"
    ),
    `$1${safeHref}$2`
  );

  // href
  out = out.replace(
    new RegExp(
      `(<image[^>]*\\bid=["']${elementId}["'][^>]*\\bhref=["'])[\\s\\S]*?(["'][^>]*>)`,
      "i"
    ),
    `$1${safeHref}$2`
  );

  return out;
}

function replaceTextContent(svgString, elementId, newText) {
  const safe = escapeXml(newText);
  return svgString.replace(
    new RegExp(
      `(<text[^>]*\\bid=["']${elementId}["'][^>]*>)([\\s\\S]*?)(</text>)`,
      "i"
    ),
    `$1${safe}$3`
  );
}

app.post("/render", async (req, res) => {
  try {
    const {
      agent_name = "Agent Name",
      background_url,
      width = 1080,
      height = 1440,
      format = "png",
      quality = 90,
    } = req.body || {};

    if (!background_url) {
      return res.status(400).json({
        error: "Missing required field",
        details: "background_url is required",
      });
    }

    const fs = require("fs");
    let svgString = fs.readFileSync("./template.svg", "utf8");

    // 1) Replace agent name
    svgString = replaceTextContent(svgString, "agent_name", agent_name);

    // 2) Fetch & embed the background (resvg will NOT load remote URLs)
    const bgDataUri = await fetchAsDataUri(background_url);
    svgString = replaceImageHref(svgString, "hero_image", bgDataUri);

    // 3) Render SVG -> PNG
    const resvg = new Resvg(svgString, {
      fitTo: { mode: "width", value: Number(width) || 1080 },
      font: { loadSystemFonts: true },
    });

    let output = resvg.render().asPng();

    // 4) Resize / output format
    const w = Number(width) || 1080;
    const h = Number(height) || 1440;

    let img = sharp(output).resize(w, h, { fit: "cover" });

    const fmt = String(format || "png").toLowerCase();
    if (fmt === "jpg" || fmt === "jpeg") {
      output = await img.jpeg({ quality: Number(quality) || 90 }).toBuffer();
      res.set("Content-Type", "image/jpeg");
    } else if (fmt === "webp") {
      output = await img.webp({ quality: Number(quality) || 90 }).toBuffer();
      res.set("Content-Type", "image/webp");
    } else {
      output = await img.png().toBuffer();
      res.set("Content-Type", "image/png");
    }

    res.send(output);
  } catch (err) {
    res.status(500).json({
      error: "Render failed",
      details: String(err && err.message ? err.message : err),
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    endpoints: {
      render: "POST /render { agent_name, background_url, width, height, format }",
    },
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`SVG renderer running on port ${port}`));
