import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateCarouselFromPost, MAX_AI_CAROUSEL_SLIDES_PER_GENERATION, MIN_POST_CAROUSEL_SLIDES } from './carouselAiService';

test('post carousel rejects more than 20 slides before resolving an AI provider', async () => {
  await assert.rejects(
    generateCarouselFromPost({ postContent: 'Draft', slideCount: MAX_AI_CAROUSEL_SLIDES_PER_GENERATION + 1, userId: 'never-loaded' }),
    /between 5 and 20/,
  );
});

test('post carousel enforces the five-slide minimum before resolving an AI provider', async () => {
  await assert.rejects(
    generateCarouselFromPost({ postContent: 'Draft', slideCount: MIN_POST_CAROUSEL_SLIDES - 1, userId: 'never-loaded' }),
    /between 5 and 20/,
  );
});

test('post carousel routes enforce entitlement, ownership state, save quota, AI quota and media conflict', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/routes/postCarousels.ts'), 'utf8');
  for (const contract of ['convertPostToCarouselEnabled', 'POST_TO_CAROUSEL_NOT_INCLUDED', 'POST_NOT_EDITABLE', 'CAROUSEL_SAVE_LIMIT_REACHED', 'CAROUSEL_AI_GENERATION_LIMIT_REACHED', 'POST_ATTACHMENT_CONFLICT', "attachmentType: 'CAROUSEL'", "carouselAttachmentStatus: 'CURRENT'"]) {
    assert.ok(source.includes(contract), `missing backend contract: ${contract}`);
  }
});

test('LinkedIn publishing uses the document upload path for carousel attachments', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/services/linkedinService.ts'), 'utf8');
  assert.ok(source.includes("post.attachmentType === 'CAROUSEL'"));
  assert.ok(source.includes('documents?action=initializeUpload'));
  assert.ok(source.includes("responseType: 'arraybuffer'"));
  assert.ok(source.includes('post.carouselFileName'));
});

test('attaching a saved carousel reuses the project without consuming AI or save usage', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/routes/postCarousels.ts'), 'utf8');
  const start = source.indexOf("router.post('/:postId/carousel/attach'");
  const end = source.indexOf("router.post('/:postId/carousel/refresh-pdf'", start);
  const attach = source.slice(start, end);
  for (const contract of ['CAROUSEL_PROJECT_NOT_FOUND', 'CAROUSEL_PROJECT_FORBIDDEN', 'CAROUSEL_PDF_FAILED', 'POST_ATTACHMENT_CONFLICT', 'renderAndStoreCarouselPdf', "carouselProjectId: selected.id"]) {
    assert.ok(attach.includes(contract), `missing saved-carousel attach contract: ${contract}`);
  }
  assert.ok(!attach.includes('carouselProject.create'));
  assert.ok(!attach.includes('carouselAiGenerationUsage.create'));
  assert.ok(!attach.includes('recordManualAiOperation'));
});
