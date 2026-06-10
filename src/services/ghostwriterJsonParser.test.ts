import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBalancedJsonObject,
  parseGeneratedJsonDetailed,
  normalizeGeneratedPayload,
} from './ghostwriterJsonParser';

describe('JSON extraction', () => {
  it('parses valid plain JSON', () => {
    const raw = '{"headline":"H","subheadline":"","bulletPoints":[],"body":"This is a valid generated post body with enough length.","hashtags":"#SaaS"}';
    const result = parseGeneratedJsonDetailed(raw);
    assert.equal(result.ok, true);
  });

  it('parses fenced JSON', () => {
    const raw = '```json\n{"headline":"H","subheadline":"","bulletPoints":[],"body":"This is a valid generated post body with enough length.","hashtags":""}\n```';
    const result = parseGeneratedJsonDetailed(raw);
    assert.equal(result.ok, true);
  });

  it('parses prose surrounding JSON', () => {
    const raw = 'Here is the post:\n{"headline":"H","subheadline":"","bulletPoints":[],"body":"This is a valid generated post body with enough length.","hashtags":""}\nThanks';
    const result = parseGeneratedJsonDetailed(raw);
    assert.equal(result.ok, true);
  });

  it('extracts nested JSON object with balanced braces', () => {
    const raw = '{"headline":"H","meta":{"nested":true},"body":"This is a valid generated post body with enough length.","hashtags":""}';
    const extracted = extractBalancedJsonObject(raw);
    assert.ok(extracted?.includes('"meta"'));
  });

  it('handles braces inside strings', () => {
    const raw = '{"headline":"Use {tenantId}","body":"This is a valid generated post body with enough length.","hashtags":""}';
    const result = parseGeneratedJsonDetailed(raw);
    assert.equal(result.ok, true);
  });

  it('reports schema validation failure distinctly', () => {
    const raw = '{"headline":"","body":"short","hashtags":""}';
    const result = parseGeneratedJsonDetailed(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, 'schema_validation');
  });

  it('reports normalization failure', () => {
    const normalized = normalizeGeneratedPayload({ foo: 'bar' });
    assert.equal(normalized, null);
    const result = parseGeneratedJsonDetailed('{"foo":"bar"}');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, 'normalization');
  });

  it('reports invalid truncated JSON', () => {
    const result = parseGeneratedJsonDetailed('{"headline":"H","body":');
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.stage === 'json_parse' || result.stage === 'json_extraction');
  });

  it('normalizes alternative body property', () => {
    const normalized = normalizeGeneratedPayload({
      title: 'Headline',
      content: 'This is a valid generated post body with enough length from content field.',
      hashtags: '#SaaS',
    });
    assert.ok(normalized);
    const result = parseGeneratedJsonDetailed(JSON.stringify({
      title: 'Headline',
      content: 'This is a valid generated post body with enough length from content field.',
      hashtags: '#SaaS',
    }));
    assert.equal(result.ok, true);
  });
});
