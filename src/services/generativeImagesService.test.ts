import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeImageError, GenerativeImagesService } from './generativeImagesService';

describe('GenerativeImagesService', () => {
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
