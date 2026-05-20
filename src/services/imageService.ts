import sharp from "sharp";
import path from "path";
import fs from "fs";
import axios from "axios";
import { uploadBufferToR2 } from "../middleware/r2";

interface PostContent {
  headline: string;
  subheadline?: string;
  bulletPoints?: string[];
}

export class ImageService {
  constructor() {}

  async createTopicImage(
    text: string,
    backgroundUrl?: string,
    content?: PostContent,
  ): Promise<string> {
    try {
      const width = 1080;
      const height = 1080;

      // -------------------------
      // 1) Parse content
      // -------------------------
      let postContent: PostContent;
      if (content) {
        postContent = content;
      } else {
        try {
          postContent = JSON.parse(text);
        } catch {
          postContent = { headline: text };
        }
      }

      // -------------------------
      // 2) Resolve background path
      // -------------------------
      let backgroundBuffer: Buffer | undefined;

      if (backgroundUrl && backgroundUrl.trim() !== "") {
        if (
          backgroundUrl.startsWith("http://") ||
          backgroundUrl.startsWith("https://")
        ) {
          const response = await axios.get(backgroundUrl, {
            responseType: "arraybuffer",
          });

          backgroundBuffer = Buffer.from(response.data);
        } else {
          const UPLOAD_DIR = process.env.RENDER
            ? "/opt/render/project/src/uploads"
            : path.join(process.cwd(), "uploads");

          const searchPaths = [
            path.isAbsolute(backgroundUrl) ? backgroundUrl : "",
            path.join(UPLOAD_DIR, backgroundUrl),
            path.join(UPLOAD_DIR, path.basename(backgroundUrl)),
            path.join(process.cwd(), "public", backgroundUrl),
            path.join(process.cwd(), backgroundUrl),
          ].filter(Boolean) as string[];

          for (const p of searchPaths) {
            if (fs.existsSync(p)) {
              backgroundBuffer = fs.readFileSync(p);
              break;
            }
          }
        }
      }

      const hasCustomBackground = !!backgroundBuffer;

      // -------------------------
      // 3) Build background (so we can sample luminance)
      // -------------------------
      const gradientSvg = `
            <svg width="${width}" height="${height}">
              <defs>
                <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stop-color="#0F172A" />
                  <stop offset="100%" stop-color="#1E1B4B" />
                </linearGradient>
                <radialGradient id="a" cx="80%" cy="20%">
                  <stop offset="0%" stop-color="#6366F1" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="#6366F1" stop-opacity="0" />
                </radialGradient>
              </defs>
              <rect width="100%" height="100%" fill="url(#g)"/>
              <rect width="100%" height="100%" fill="url(#a)"/>
            </svg>
          `;

      let backgroundSharp = sharp(Buffer.from(gradientSvg)).resize(
        width,
        height,
        { fit: "fill" },
      );

      if (hasCustomBackground) {
        backgroundSharp = sharp(backgroundBuffer!).resize(width, height, {
          fit: "cover",
          position: "centre",
        });
      }

      // -------------------------
      // 4) Layout text inside a SAFE BOX
      // -------------------------
      const headlineRaw = (postContent.headline || text).trim();
      const subheadlineRaw = (postContent.subheadline || "").trim();
      const bulletsRaw = (postContent.bulletPoints || [])
        .filter(Boolean)
        .map((s) => String(s).trim());

      const safe = {
        left: hasCustomBackground ? 90 : 140,
        right: hasCustomBackground ? 90 : 80, // more usable width
        top: hasCustomBackground ? 220 : 160,
        bottom: hasCustomBackground ? 140 : 170,
      };

      const boxWidth = width - safe.left - safe.right;
      const boxHeight = height - safe.top - safe.bottom;

      // Body indent columns
      const bodyLeft = safe.left + 70;
      const bodyMaxWidth = width - safe.right - bodyLeft;

      // Subheadline anchor (moved slightly left to gain width)
      const subCenterX = width / 2;

      // centered max width = distance between safe margins
      const subMaxWidth = width - safe.left - safe.right;

      // Sample luminance in the text region to pick theme
      const sampleRegion = {
        left: safe.left,
        top: safe.top,
        width: Math.max(1, boxWidth),
        height: Math.max(1, Math.min(520, boxHeight)),
      };

      const renderedBackgroundBuffer = await backgroundSharp
        .clone()
        .resize(width, height, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();

      const backgroundRaster = sharp(renderedBackgroundBuffer);
      const lum = await this.getAverageLuminance(
        backgroundRaster,
        sampleRegion,
      );
      const theme = this.getThemeForLuminance(lum);

      // Subtle overlay to increase contrast
      const overlayBuffer = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: theme.overlayAlpha },
        },
      })
        .png()
        .toBuffer();

      const baseImage: sharp.Sharp = sharp(renderedBackgroundBuffer).composite([
        { input: overlayBuffer, blend: "over" },
      ]);

      // -------------------------
      // 5) Typography config (auto-shrink to fit)
      // -------------------------
      let hSize = hasCustomBackground ? 64 : 62;
      let shSize = hasCustomBackground ? 32 : 30;
      let bSize = hasCustomBackground ? 30 : 28;

      const min = { h: 40, sh: 28, b: 22 };

      const line = {
        h: () => Math.round(hSize * 1.1),
        sh: () => Math.round(shSize * 1.32),
        b: () => Math.round(bSize * 1.35),
      };

      // Heuristic wrapping (less conservative than before)
      const wrapByPixelWidth = (
        txt: string,
        maxWidthPx: number,
        fontSize: number,
        charWidthFactor = 0.48,
      ): string[] => {
        const avgChar = fontSize * charWidthFactor;
        const maxChars = Math.max(8, Math.floor(maxWidthPx / avgChar));

        const words = txt
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .filter(Boolean);
        const lines: string[] = [];
        let cur = "";

        for (const w of words) {
          const next = cur ? `${cur} ${w}` : w;
          if (next.length <= maxChars) {
            cur = next;
          } else {
            if (cur) lines.push(cur);
            cur = w;
          }
        }
        if (cur) lines.push(cur);
        return lines;
      };

      const estimateTextWidth = (
        txt: string,
        fontSize: number,
        factor = 0.46,
      ) => {
        const t = txt.replace(/\s+/g, " ").trim();
        return t.length * fontSize * factor;
      };

      const clampLines = (lines: string[], maxLines: number) => {
        if (lines.length <= maxLines) return lines;
        const sliced = lines.slice(0, maxLines);
        const last = sliced[maxLines - 1];
        sliced[maxLines - 1] = this.ellipsize(
          last,
          Math.max(6, last.length - 1),
        );
        return sliced;
      };

      const measureBlockHeight = (
        hLines: number,
        shLines: number,
        bulletLineCount: number,
      ) => {
        const gapAfterHeadline = hLines ? Math.round(hSize * 0.5) : 0;
        const gapAfterSub = shLines ? Math.round(shSize * 0.8) : 0;

        return (
          hLines * line.h() +
          gapAfterHeadline +
          shLines * line.sh() +
          gapAfterSub +
          bulletLineCount * line.b()
        );
      };

      // Build wrapped lines
      let headlineLines: string[] = [];
      let subheadlineLines: string[] = [];
      let bulletLineGroups: string[][] = [];
      let subUseTextLength = false; // <— forces single-line via SVG when needed

      const fitHeadline = () => {
        // Try to fit headline into 2 lines by shrinking hSize first
        for (let tries = 0; tries < 18; tries++) {
          const lines = wrapByPixelWidth(headlineRaw, boxWidth, hSize, 0.5);
          if (lines.length <= 2) return lines;
          if (hSize > min.h) hSize -= 2;
          else break;
        }
        // If still too long at min size, clamp + ellipsize
        const lines = wrapByPixelWidth(headlineRaw, boxWidth, hSize, 0.5);
        return clampLines(lines, 2);
      };

      const fitSubheadline = () => {
        if (!subheadlineRaw) return [];

        // ALWAYS keep it to one line.
        // Shrink shSize until our estimate says it fits; if still too long at min,
        // we render with SVG textLength to force-fit without wrapping.
        for (let tries = 0; tries < 30; tries++) {
          const w = estimateTextWidth(subheadlineRaw, shSize, 0.46);
          if (w <= subMaxWidth) {
            subUseTextLength = false;
            return [subheadlineRaw];
          }

          if (shSize > min.sh) {
            shSize -= 1;
            continue;
          }

          subUseTextLength = true;
          return [subheadlineRaw];
        }

        subUseTextLength = true;
        return [subheadlineRaw];
      };

      const buildLines = () => {
        headlineLines = fitHeadline();
        subheadlineLines = fitSubheadline();

        // Bullets: keep up to 3 bullets, wrap each bullet; cap per bullet to avoid huge vertical growth
        bulletLineGroups = bulletsRaw.slice(0, 3).map((b) => {
          const wrapped = wrapByPixelWidth(`• ${b}`, bodyMaxWidth, bSize, 0.46);
          return clampLines(wrapped, 3);
        });
      };

      buildLines();

      // Shrink typography until total height fits
      for (let i = 0; i < 40; i++) {
        const bulletLineCount = bulletLineGroups.length
          ? bulletLineGroups.reduce((acc, g) => acc + g.length, 0) +
            (bulletLineGroups.length - 1)
          : 0;

        const totalH = measureBlockHeight(
          headlineLines.length,
          subheadlineLines.length,
          bulletLineCount,
        );

        if (totalH <= boxHeight) break;

        if (hSize > min.h) hSize -= 2;
        if (shSize > min.sh) shSize -= 1;
        if (bSize > min.b) bSize -= 1;

        buildLines();

        if (hSize <= min.h && shSize <= min.sh && bSize <= min.b) break;
      }

      // -------------------------
      // 6) Compute anchors + SVG overlay
      // -------------------------
      const bulletLineCount = bulletLineGroups.length
        ? bulletLineGroups.reduce((acc, g) => acc + g.length, 0) +
          (bulletLineGroups.length - 1)
        : 0;

      const contentHeight = measureBlockHeight(
        headlineLines.length,
        subheadlineLines.length,
        bulletLineCount,
      );

      // Center within safe box, then push down a bit (tweak 0..40)
      const extraDown = 22; // <-- adjust to taste
      const yOffset = Math.max(
        0,
        Math.floor((boxHeight - contentHeight) / 2) + extraDown,
      );

      let y = safe.top + yOffset;

      const centerX = width / 2;
      const headlineCentered = hasCustomBackground;

      const dotX = safe.left + 40;

      // Optional brand elements (only on default bg like your original)
      const showBrand = !hasCustomBackground;

      const contentSvg = `
            <svg width="${width}" height="${height}">
              <defs>
                <filter id="shadow" x="-25%" y="-25%" width="150%" height="150%">
                  <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="${theme.shadow}" />
                </filter>

                <style>
                  .h {
                    fill: ${theme.headline};
                    font-size: ${hSize}px;
                    font-weight: 800;
                    letter-spacing: -0.02em;
                    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                    filter: url(#shadow);
                  }
                  .sh {
                    fill: ${theme.subheadline};
                    font-size: ${shSize}px;
                    font-weight: 600;
                    letter-spacing: -0.01em;
                    opacity: 0.92;
                    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                    filter: url(#shadow);
                  }
                  .b {
                    fill: ${theme.bullet};
                    font-size: ${bSize}px;
                    font-weight: 550;
                    letter-spacing: 0;
                    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                    filter: url(#shadow);
                  }
                  .dot {
                    fill: ${
                      theme.headline === "#FFFFFF"
                        ? "rgba(255,255,255,0.35)"
                        : "rgba(15,23,42,0.35)"
                    };
                    font-size: ${bSize + 6}px;
                    font-weight: 900;
                    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                    filter: url(#shadow);
                  }
                </style>
              </defs>

              ${
                showBrand
                  ? `
                    <text x="${safe.left}" y="100" class="logo">iT</text>
                    <text x="${safe.left}" y="${safe.top - 20}" class="q">"</text>
                  `
                  : ""
              }

              <!-- Headline -->
              ${headlineLines
                .map((ln, i) => {
                  const yy = y + i * line.h();
                  const x = headlineCentered ? centerX : safe.left;
                  const anchor = headlineCentered ? "middle" : "start";
                  return `<text x="${x}" y="${yy}" text-anchor="${anchor}" class="h">${this.escapeXml(
                    ln,
                  )}</text>`;
                })
                .join("")}

              ${(() => {
                y += headlineLines.length * line.h();
                if (headlineLines.length) y += Math.round(hSize * 0.65);
                return "";
              })()}

              <!-- Subheadline (forced single-line when needed) -->
            ${subheadlineLines
              .map((ln, i) => {
                const yy = y + i * line.sh();
                const textLengthAttr = subUseTextLength
                  ? ` textLength="${subMaxWidth}" lengthAdjust="spacingAndGlyphs"`
                  : "";
                return `<text x="${subCenterX}" y="${yy}" text-anchor="middle" class="sh"${textLengthAttr}>${this.escapeXml(
                  ln,
                )}</text>`;
              })
              .join("")}

              ${(() => {
                y += subheadlineLines.length * line.sh();
                if (subheadlineLines.length) y += Math.round(shSize * 1.4);
                return "";
              })()}

              <!-- Bullets -->
              ${bulletLineGroups
                .map((group, bi) => {
                  const chunk = group
                    .map((ln, li) => {
                      const yy = y + li * line.b();
                      const clean = ln.replace(/^•\s*/, "");

                      if (li === 0) {
                        return `
                          <text x="${dotX}" y="${yy}" text-anchor="start" class="dot">•</text>
                          <text x="${bodyLeft}" y="${yy}" text-anchor="start" class="b">${this.escapeXml(
                            clean,
                          )}</text>
                        `;
                      }

                      // Wrapped lines align with bullet text column (no dot)
                      return `<text x="${bodyLeft}" y="${yy}" text-anchor="start" class="b">${this.escapeXml(
                        clean,
                      )}</text>`;
                    })
                    .join("");

                  y += group.length * line.b();
                  if (bi < bulletLineGroups.length - 1)
                    y += Math.round(bSize * 0.75);
                  return chunk;
                })
                .join("")}

              ${
                showBrand
                  ? `
                    <line x1="${safe.left}" y1="${height - 130}" x2="${width - safe.right}" y2="${
                      height - 130
                    }" stroke="#334155" />
                    <text x="${safe.left + 40}" y="${height - 80}" class="footer">🌐 innovariatech.com</text>
                    <text x="${safe.left + 360}" y="${height - 80}" class="footer">📷 innovariatech</text>
                    <text x="${safe.left + 640}" y="${height - 80}" class="footer">✕ innovariatech</text>
                  `
                  : ""
              }
            </svg>
          `;

      // -------------------------
      // 7) Composite + output
      // -------------------------
      const outputFilename = `generated/post-${Date.now()}.jpg`;

      const outputBuffer = await baseImage
        .resize(width, height, { fit: "cover" })
        .composite([{ input: Buffer.from(contentSvg), top: 0, left: 0 }])
        .jpeg({ quality: 82, progressive: true })
        .toBuffer();

      const url = await uploadBufferToR2(
        outputBuffer,
        outputFilename,
        "image/jpeg",
      );

      return url;
    } catch (error) {
      console.error("Image Error:", error);
      throw error;
    }
  }

  private async getAverageLuminance(
    img: sharp.Sharp,
    region: { left: number; top: number; width: number; height: number },
  ): Promise<number> {
    const meta = await img.clone().metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;

    if (imgW <= 0 || imgH <= 0) return 128;

    let left = Math.max(0, Math.floor(region.left));
    let top = Math.max(0, Math.floor(region.top));
    let width = Math.max(1, Math.floor(region.width));
    let height = Math.max(1, Math.floor(region.height));

    if (left >= imgW) left = imgW - 1;
    if (top >= imgH) top = imgH - 1;

    if (left + width > imgW) width = imgW - left;
    if (top + height > imgH) height = imgH - top;

    if (width <= 0 || height <= 0) return 128;

    const buf = await img
      .clone()
      .extract({ left, top, width, height })
      .resize(1, 1, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();

    const r = buf[0],
      g = buf[1],
      b = buf[2];

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  private getThemeForLuminance(lum: number) {
    const isBright = lum > 160;

    if (isBright) {
      return {
        headline: "#0F172A",
        subheadline: "rgba(15,23,42,0.85)",
        bullet: "rgba(15,23,42,0.72)",
        cardFill: "rgba(255,255,255,0.82)",
        cardStroke: "rgba(15,23,42,0.12)",
        shadow: "rgba(0,0,0,0.18)",
        overlayAlpha: 0.1,
      };
    }

    return {
      headline: "#FFFFFF",
      subheadline: "rgba(255,255,255,0.86)",
      bullet: "rgba(255,255,255,0.74)",
      cardFill: "rgba(15,23,42,0.58)",
      cardStroke: "rgba(255,255,255,0.12)",
      shadow: "rgba(0,0,0,0.55)",
      overlayAlpha: 0.32,
    };
  }

  private ellipsize(s: string, keep: number): string {
    const t = (s || "").trim();
    if (t.length <= keep) return t;
    return t.slice(0, Math.max(1, keep - 1)).trimEnd() + "…";
  }

  private escapeXml(s: string): string {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}
