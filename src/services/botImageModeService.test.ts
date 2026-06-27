import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchGenerativeImageInput,
  parseBotImageModeInput,
  resolveBotImageMode,
} from './botImageModeService';

describe('bot image mode', () => {
  it('defaults to providedBackground when backgroundImageUrl exists without imageMode', () => {
    assert.equal(
      resolveBotImageMode({ imageMode: null, backgroundImageUrl: 'https://cdn.example/bg.png' }),
      'providedBackground',
    );
  });

  it('defaults to none when imageMode and background are absent', () => {
    assert.equal(resolveBotImageMode({ imageMode: null, backgroundImageUrl: null }), 'none');
  });

  it('prefers explicit imageMode over legacy backgroundImageUrl', () => {
    assert.equal(
      resolveBotImageMode({
        imageMode: 'aiGenerated',
        backgroundImageUrl: 'https://cdn.example/bg.png',
      }),
      'aiGenerated',
    );
    assert.equal(
      resolveBotImageMode({ imageMode: 'none', backgroundImageUrl: 'https://cdn.example/bg.png' }),
      'none',
    );
  });

  it('parses valid imageMode input', () => {
    assert.equal(parseBotImageModeInput('aiGenerated'), 'aiGenerated');
    assert.throws(() => parseBotImageModeInput('invalid'));
  });

  it('forwards saved batch image personalization to Gemini input', () => {
    const input = buildBatchGenerativeImageInput({
      userId: 'user-1',
      imageMode: 'aiGenerated',
      postContent: 'Finalized post text',
      imageInstructions: 'Use a clean operations metaphor',
      imageStyle: 'minimal',
      imageAspectRatio: '4:5',
      profileDescription: 'I advise B2B SaaS operators.',
      brandName: 'Acme',
      imageService: {} as never,
      finalized: { headline: 'Headline', subheadline: 'Subhead', bulletPoints: [] },
      imageContent: null,
    });

    assert.deepEqual(input, {
      postText: 'Finalized post text',
      instructions: 'Use a clean operations metaphor',
      style: 'minimal',
      aspectRatio: '4:5',
      profileDescription: 'I advise B2B SaaS operators.',
      brandName: 'Acme',
    });
  });
});
