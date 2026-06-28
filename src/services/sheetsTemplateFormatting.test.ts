import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPostTemplateFormattingRequests,
  getPostTemplateExampleScheduledAt,
  isSelectableGoogleSheetMediaRowStatus,
} from './sheetsService';

describe('Google Sheets post template formatting', () => {
  it('only offers rows that can still accept draft media', () => {
    assert.equal(isSelectableGoogleSheetMediaRowStatus('DRAFT'), true);
    assert.equal(isSelectableGoogleSheetMediaRowStatus(''), true);
    assert.equal(isSelectableGoogleSheetMediaRowStatus(' queued '), false);
    assert.equal(isSelectableGoogleSheetMediaRowStatus('PUBLISHED'), false);
  });

  it('keeps six configured widths and adds strict status validation', () => {
    const requests = buildPostTemplateFormattingRequests(123);
    const widths = requests
      .map((request) => request.updateDimensionProperties)
      .filter((update) => update?.range?.dimension === 'COLUMNS')
      .map((update) => update?.properties?.pixelSize);
    assert.deepEqual(widths, [180, 600, 240, 190, 300, 160]);

    const validation = requests.find(
      (request) => request.setDataValidation?.range?.startColumnIndex === 5,
    )?.setDataValidation;
    assert.equal(validation?.rule?.strict, true);
    assert.deepEqual(
      validation?.rule?.condition?.values?.map((value) => value.userEnteredValue),
      ['QUEUED', 'DRAFT', 'PUBLISHED'],
    );
    assert.equal(validation?.range?.startRowIndex, 1);
    assert.equal(validation?.range?.endRowIndex, 1000);
  });

  it('uses a current future date and validates scheduledAt as a date', () => {
    const now = new Date('2026-06-29T12:34:00.000Z');
    assert.equal(getPostTemplateExampleScheduledAt(now), '2026-06-30 10:00');

    const requests = buildPostTemplateFormattingRequests(123);
    const validation = requests.find(
      (request) => request.setDataValidation?.range?.startColumnIndex === 3,
    )?.setDataValidation;
    assert.equal(validation?.rule?.condition?.type, 'DATE_IS_VALID');
    assert.equal(validation?.rule?.strict, true);
  });

  it('freezes and styles the header while adding a filter', () => {
    const requests = buildPostTemplateFormattingRequests(123);
    assert.equal(
      requests.find((request) => request.updateSheetProperties)
        ?.updateSheetProperties?.properties?.gridProperties?.frozenRowCount,
      1,
    );
    assert.ok(requests.some((request) => request.setBasicFilter));
    assert.equal(
      requests.find((request) => request.repeatCell?.range?.startRowIndex === 0)
        ?.repeatCell?.cell?.userEnteredFormat?.textFormat?.bold,
      true,
    );
  });
});
