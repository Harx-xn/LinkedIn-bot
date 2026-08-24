import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerativeImageError,
  GenerativeImagesService,
  buildLinkedInImagePrompt,
  buildImageTextCorrectionInstructions,
  buildImageTextQualityPrompt,
  parseImageTextQualityResult,
  resolveImageCreativeDirection,
} from './generativeImagesService';

describe('GenerativeImagesService', () => {
  it('includes creator profile context and personalization rules in the prompt', () => {
    const prompt = buildLinkedInImagePrompt({
      postText: 'A post about simplifying sales operations.',
      profileDescription: 'I help B2B SaaS founders build repeatable revenue systems.',
    });

    assert.match(prompt, /SUPPORTING CREATOR \/ PROFILE CONTEXT/);
    assert.match(prompt, /I help B2B SaaS founders build repeatable revenue systems\./);
    assert.match(prompt, /Treat profile context only as supporting/);
    assert.match(prompt, /not like a generic AI\/tech motivational poster/);
    assert.match(prompt, /Avoid weird surreal 3D scenes/);
    assert.match(prompt, /Prefer one to five words per label/);
    assert.match(prompt, /Never include hashtags or text beginning with # anywhere in the image/);
    assert.match(prompt, /Never render the creator's niche name/);
    assert.match(prompt, /VISUAL CONCEPT/);
  });

  it('asks visual QA to detect spelling, incomplete words, and cropped text', () => {
    const prompt = buildImageTextQualityPrompt('A post about customer retention.');
    assert.match(prompt, /Misspellings/);
    assert.match(prompt, /Incomplete words/);
    assert.match(prompt, /clipped, cropped/);
    assert.match(prompt, /customer retention/);
  });

  it('parses image text defects and builds exact correction instructions', () => {
    const result = parseImageTextQualityResult(JSON.stringify({
      passed: false,
      visibleText: ['Custmer Retent'],
      spellingErrors: [{ rendered: 'Custmer', correction: 'Customer' }],
      incompleteWords: ['Retent'],
      cutOffText: ['Retent'],
      issues: ['Final label touches the right edge.'],
    }));
    assert.equal(result.passed, false);
    const correction = buildImageTextCorrectionInstructions(result);
    assert.match(correction, /Replace "Custmer" with "Customer"/);
    assert.match(correction, /incomplete word or fragment "Retent"/);
    assert.match(correction, /fully inside the canvas/);
  });

  it('does not accept a contradictory QA pass when defect arrays are populated', () => {
    const result = parseImageTextQualityResult('{"passed":true,"visibleText":["Wrng"],"spellingErrors":[{"rendered":"Wrng","correction":"Wrong"}],"incompleteWords":[],"cutOffText":[],"issues":[]}');
    assert.equal(result.passed, false);
  });

  it('resolves creative direction from universal post structure', () => {
    const comparison = resolveImageCreativeDirection({
      postText: 'Manual work versus automated work: both can deliver quality, but one removes repeated friction.',
    });
    assert.equal(comparison.composition, 'split');
    assert.equal(comparison.visualFormat, 'visual_comparison');
    assert.equal(comparison.textMode, 'minimal');

    const disconnected = resolveImageCreativeDirection({
      postText: 'The tools are individually excellent, but they do not communicate with each other.',
    });
    assert.equal(disconnected.composition, 'layered_editorial');
    assert.match(disconnected.visualConcept, /components separated/i);
  });

  it('selects feed-native formats and text behavior from message structure', () => {
    const process = resolveImageCreativeDirection({
      postText: 'Here is the workflow. First collect the input. Second validate it. Finally publish the result.',
    });
    assert.equal(process.visualFormat, 'diagram');
    assert.equal(process.textMode, 'structured');
    assert.equal(process.composition, 'layered_editorial');

    const timeline = resolveImageCreativeDirection({
      postText: 'We transformed from scattered manual work to one coordinated system.',
    });
    assert.equal(timeline.visualFormat, 'timeline_transformation');
    assert.equal(timeline.composition, 'progression');

    const statistic = resolveImageCreativeDirection({
      postText: '70% of respondents abandoned the task. That number is the signal we cannot ignore.',
    });
    assert.equal(statistic.visualFormat, 'data_graphic');
    assert.equal(statistic.textMode, 'minimal');
  });

  it('lets custom instructions override Auto format and human presence', () => {
    const direction = resolveImageCreativeDirection({
      postText: 'Every approval adds another frustrating loop to the work.',
      instructions: 'Make this a humorous 4-stage comic. Do not include people.',
      visualFormat: 'auto',
      humanPresence: 'auto',
    });
    assert.equal(direction.visualFormat, 'comic');
    assert.equal(direction.composition, 'grid');
    assert.equal(direction.mood, 'playful');
    assert.equal(direction.humanPresence, 'none');
    assert.equal(direction.textMode, 'structured');
  });

  it('validates optional controls while preserving legacy request fields', async () => {
    const { parseImageCreativeOverrides } = await import('./generativeImagesService');
    assert.deepEqual(parseImageCreativeOverrides({
      instructions: 'legacy', style: 'professional', aspectRatio: '4:5',
      visualFormat: 'comic', textMode: 'structured', humanPresence: 'not-valid',
    }), { visualFormat: 'comic', textMode: 'structured' });
  });

  it('preserves explicit settings while resolving Auto fields from the post', () => {
    const direction = resolveImageCreativeDirection({
      postText: 'A process with three connected steps that turns noise into clarity.',
      imageType: 'photorealistic',
      composition: 'close_up',
      mood: 'auto',
    });
    assert.equal(direction.imageType, 'photorealistic');
    assert.equal(direction.composition, 'close_up');
    assert.notEqual(direction.mood, 'auto');
  });

  it('builds one post-first art-directed prompt without niche templates', () => {
    const prompt = buildLinkedInImagePrompt({
      postText: 'The bottleneck is not effort. It is the one approval step constraining the entire flow.',
      style: 'auto',
    });
    assert.match(prompt, /OBJECTIVE/);
    assert.match(prompt, /CENTRAL MESSAGE/);
    assert.match(prompt, /VISUAL CONCEPT/);
    assert.match(prompt, /one consequential point/);
    assert.match(prompt, /Never let niche dictate/);
    assert.match(prompt, /Do not reproduce every sentence/);
  });

  it('uses the profile context fallback when none is supplied', () => {
    const prompt = buildLinkedInImagePrompt({ postText: 'A focused LinkedIn post.' });
    assert.match(prompt, /No specific creator profile context provided\./);
  });

  it('throws when postText is missing', async () => {
    const service = new GenerativeImagesService({ geminiApiKeys: ['test-key'] });
    await assert.rejects(
      () => service.generateLinkedInPostImage({ postText: '   ' }),
      /postText is required/,
    );
  });

  it('throws when no Gemini keys are provided', async () => {
    const service = new GenerativeImagesService({ geminiApiKeys: [] });
    await assert.rejects(
      () => service.generateLinkedInPostImage({ postText: 'Hello LinkedIn' }),
      /No Gemini API keys available/,
    );
  });

  it('exposes GenerativeImageError for quota failures', () => {
    const err = new GenerativeImageError(429, 'GEMINI_IMAGE_QUOTA_EXCEEDED', 'quota exhausted');
    assert.equal(err.code, 'GEMINI_IMAGE_QUOTA_EXCEEDED');
    assert.equal(err.status, 429);
  });

  it('accepts constructor with decrypted geminiApiKeys array', () => {
    const service = new GenerativeImagesService({
      geminiApiKeys: ['key-one', 'key-two'],
    });
    assert.ok(service instanceof GenerativeImagesService);
  });

  it('userContentContext exposes getGenerativeImagesServiceForUser using regional keys', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/services/userContentContext.ts'),
      'utf8',
    );
    assert.ok(source.includes('getDecryptedGeminiKeysForUser'));
    assert.ok(source.includes('getGenerativeImagesServiceForUser'));
    assert.ok(source.includes('decryptSecretArray'));
    assert.ok(source.includes('new GenerativeImagesService({ geminiApiKeys })'));
    assert.ok(!source.includes('process.env.GEMINI_API_KEY'));
  });
});
