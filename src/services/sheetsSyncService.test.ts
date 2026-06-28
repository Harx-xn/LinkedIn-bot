import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGoogleInvalidGrantError,
  normalizeSheetPostStatus,
  shouldPreservePublishedStatus,
} from './sheetsSyncService';
import {
  GOOGLE_OAUTH_SCOPES,
  findGoogleSheetPostStatusCell,
  getGoogleSheetColumnName,
  getGoogleSheetsAccessErrorMessage,
} from './sheetsService';

describe('Google Sheets sync errors', () => {
  it('detects invalid_grant in message', () => {
    assert.equal(isGoogleInvalidGrantError(new Error('invalid_grant')), true);
  });

  it('detects invalid_grant in response payload', () => {
    assert.equal(isGoogleInvalidGrantError({ response: { data: { error: 'invalid_grant' } } }), true);
  });

  it('treats other errors as retryable', () => {
    assert.equal(isGoogleInvalidGrantError(new Error('network timeout')), false);
  });
});

describe('Google Sheets OAuth scopes', () => {
  it('uses only drive.file for the Sheets integration', () => {
    assert.deepEqual(GOOGLE_OAUTH_SCOPES, [
      'https://www.googleapis.com/auth/drive.file',
    ]);
    assert.equal(
      GOOGLE_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/spreadsheets'),
      false,
    );
    assert.equal(
      GOOGLE_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/drive'),
      false,
    );
  });
});

describe('Google Sheets access errors', () => {
  it('explains missing refresh tokens', () => {
    assert.match(
      getGoogleSheetsAccessErrorMessage(new Error('missing_refresh_token')) || '',
      /missing a refresh token/i,
    );
  });

  it('explains inaccessible sheets under limited permissions', () => {
    assert.match(
      getGoogleSheetsAccessErrorMessage({ code: 403, message: 'insufficient permissions' }) || '',
      /use a sheet created by this app/i,
    );
  });
});

describe('Google Sheets post status normalization', () => {
  it('maps queue and schedule aliases to the app queued status', () => {
    assert.deepEqual(normalizeSheetPostStatus('queue'), {
      status: 'QUEUED',
      skip: false,
      invalid: false,
    });
    assert.equal(normalizeSheetPostStatus('SCHEDULED').status, 'QUEUED');
  });

  it('does not turn invalid or empty values into a database status', () => {
    assert.deepEqual(normalizeSheetPostStatus('not-a-status'), {
      status: null,
      skip: false,
      invalid: true,
    });
    assert.deepEqual(normalizeSheetPostStatus(''), {
      status: null,
      skip: false,
      invalid: false,
    });
  });

  it('keeps SKIP as a sheet-only instruction', () => {
    assert.equal(normalizeSheetPostStatus('skip').skip, true);
  });

  it('keeps published posts terminal even when a stale Sheet row says draft', () => {
    assert.equal(
      shouldPreservePublishedStatus({ status: 'DRAFT', publishedAt: new Date() }),
      true,
    );
    assert.equal(
      shouldPreservePublishedStatus({ status: 'PUBLISHED', publishedAt: null }),
      true,
    );
    assert.equal(
      shouldPreservePublishedStatus({ status: 'DRAFT', publishedAt: null }),
      false,
    );
  });
});

describe('Google Sheets column names', () => {
  it('supports columns beyond Z for broad import ranges', () => {
    assert.equal(getGoogleSheetColumnName(1), 'A');
    assert.equal(getGoogleSheetColumnName(26), 'Z');
    assert.equal(getGoogleSheetColumnName(27), 'AA');
  });

  it('finds the status cell by stable appPostId even when columns move', () => {
    assert.equal(
      findGoogleSheetPostStatusCell(
        [
          ['content', 'status', 'appPostId'],
          ['First post', 'QUEUED', 'post-1'],
          ['Second post', 'DRAFT', 'post-2'],
        ],
        'post-2',
      ),
      'B3',
    );
  });

  it('returns null when the post row or required headers are absent', () => {
    assert.equal(findGoogleSheetPostStatusCell([['content', 'status']], 'post-1'), null);
    assert.equal(
      findGoogleSheetPostStatusCell([['status', 'appPostId'], ['DRAFT', 'other']], 'post-1'),
      null,
    );
  });
});
