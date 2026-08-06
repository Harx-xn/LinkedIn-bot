import { chromium } from 'playwright';
import { config } from '../config';
import { uploadBufferToR2 } from '../middleware/r2';
import { createCarouselExport, deleteCarouselExport } from './carouselExportStore';

export function carouselFileName(title: string) {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'carousel'}.pdf`;
}

export async function renderCarouselPdf(project: any): Promise<Buffer> {
  const token = createCarouselExport({ project, attributionRequired: false, filename: carouselFileName(project.title) });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 768, height: 960 }, deviceScaleFactor: 1 });
    await page.goto(`${config.frontendUrl.replace(/\/$/, '')}/carousel-export/${encodeURIComponent(token)}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector('.cm-export-document.is-ready', { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(await page.pdf({ width: '8in', height: '10in', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }));
  } finally {
    deleteCarouselExport(token);
    await browser?.close();
  }
}

export async function renderAndStoreCarouselPdf(input: { project: any; userId: string; postId: string }) {
  const buffer = await renderCarouselPdf(input.project);
  const filename = carouselFileName(input.project.title);
  const key = `generated/carousels/${input.userId}/${input.postId}-${Date.now()}.pdf`;
  const url = await uploadBufferToR2(buffer, key, 'application/pdf');
  return { url, filename, buffer, key };
}
