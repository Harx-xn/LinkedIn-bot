import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBotImageModeInput, resolveBotImageMode } from './botImageModeService';

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
});
