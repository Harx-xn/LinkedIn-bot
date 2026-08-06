import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('manual vs batch architectural isolation', () => {
  it('manual orchestration does not call ContentService.generateManualPost', () => {
    const orchestration = readSrc('services/manualPost/manualPostOrchestration.ts');
    const provider = readSrc('services/manualPost/manualAiProvider.ts');
    assert.ok(!orchestration.includes('.generateManualPost('));
    assert.ok(!provider.includes('.generateManualPost('));
    assert.ok(orchestration.includes('runManualGenerationMultiStage'));
    assert.ok(orchestration.includes('invokeManualRewritePrompt'));
  });

  it('manual orchestration does not call ContentService.rewritePost directly', () => {
    const orchestration = readSrc('services/manualPost/manualPostOrchestration.ts');
    assert.ok(!orchestration.includes('rewritePost'));
  });

  it('batch generation still uses generatePlannedPost in ghostwriterGenerationService', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    assert.ok(batchGen.includes('generatePlannedPost'));
    assert.ok(!batchGen.includes('executeComposerGenerationPrompt'));
    assert.ok(!batchGen.includes('executeComposerRewritePrompt'));
  });

  it('batch generation uses bounded waves and skips unused image-copy calls', () => {
    const trending = readSrc('services/trendingBotService.ts');
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    assert.ok(trending.includes('BATCH_GENERATION_CONCURRENCY'));
    assert.ok(trending.includes('Promise.all(waveIndexes.map'));
    assert.ok(trending.includes('regenerating concurrent batch collision'));
    assert.ok(batchGen.includes("config.imageMode === 'providedBackground'"));
  });

  it('batch pipeline does not import manual orchestration', () => {
    const pipeline = readSrc('services/ghostwriterPipeline.ts');
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(!pipeline.includes('manualPost'));
    assert.ok(!trending.includes('manualPostOrchestration'));
    assert.ok(!trending.includes('executeComposer'));
  });

  it('generateManualPostV2 does not create Post rows', () => {
    const orchestration = readSrc('services/manualPost/manualPostOrchestration.ts');
    const generateFn = orchestration.slice(
      orchestration.indexOf('export async function generateManualPostV2'),
      orchestration.indexOf('export async function rewriteUnsavedManualPostV2'),
    );
    assert.ok(!generateFn.includes('prisma.post.create'));
    assert.ok(!generateFn.includes('prisma.post.update'));
  });

  it('saved rewrite still increments rewriteCount on Post update only', () => {
    const orchestration = readSrc('services/manualPost/manualPostOrchestration.ts');
    const savedRewrite = orchestration.slice(
      orchestration.indexOf('async function findRewritableManualPost'),
    );
    assert.ok(savedRewrite.includes('rewriteCount: { increment: 1 }'));
    assert.ok(savedRewrite.includes('canRewritePost(userId, post.id)'));
    assert.ok(savedRewrite.includes('where: { id: postId, userId }'));
    assert.ok(savedRewrite.includes('findRewritableManualPost(userId, postId)'));
  });

  it('ContentService composer methods are documented manual-only', () => {
    const contentService = readSrc('services/contentService.ts');
    assert.ok(contentService.includes('executeComposerGenerationPrompt'));
    assert.ok(contentService.includes('executeComposerRewritePrompt'));
    assert.ok(contentService.includes('fetchComposerGenerationRaw'));
    assert.ok(contentService.includes('Manual-composer only'));
  });

  it('batch paths do not load PostContentFingerprint', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(!batchGen.includes('getRecentManualFingerprints'));
    assert.ok(!batchGen.includes('PostContentFingerprint'));
    assert.ok(!trending.includes('manualPostFingerprint'));
  });

  it('batch paths do not lookup UserVoiceProfile', () => {
    const batchGen = readSrc('services/ghostwriterGenerationService.ts');
    const postsRoute = readSrc('routes/posts.ts');
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(!batchGen.includes('UserVoiceProfile'));
    assert.ok(!batchGen.includes('getManualVoiceContext'));
    assert.ok(!postsRoute.includes('getManualVoiceContext'));
    assert.ok(!trending.includes('manualVoiceProfile'));
  });

  it('manual provider uses manual raw fetch not batch parseProviderOutput', () => {
    const provider = readSrc('services/manualPost/manualAiProvider.ts');
    assert.ok(provider.includes('invokeManualPlanningPrompt'));
    assert.ok(provider.includes('invokeManualDraftPrompt'));
    assert.ok(provider.includes('invokeManualCriticPrompt'));
    assert.ok(provider.includes('fetchComposerGenerationRaw'));
    assert.ok(provider.includes('fetchComposerRewriteRaw'));
    assert.ok(provider.includes('parseManualProviderOutputWithRepair'));
    assert.ok(!provider.includes('executeComposerGenerationPrompt'));
    assert.ok(!provider.includes('parseProviderOutput'));
  });
});

describe('batch response and provider paths unchanged', () => {
  it('trendingBotService still hardcodes OPENAI provider for batch slots', () => {
    const trending = readSrc('services/trendingBotService.ts');
    assert.ok(trending.includes('const provider: "OPENAI" = "OPENAI"'));
    assert.ok(!trending.includes('executeComposerGenerationPrompt'));
  });

  it('posts batch rewrite route still uses rewritePost not manual orchestration', () => {
    const postsRoute = readSrc('routes/posts.ts');
    const rewriteHandler = postsRoute.slice(postsRoute.indexOf("router.post('/:id/rewrite'"));
    assert.ok(rewriteHandler.includes('rewritePost'));
    assert.ok(!rewriteHandler.includes('manualPost'));
    assert.ok(rewriteHandler.includes("'OPENAI'"));
  });
});
