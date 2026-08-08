import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseLinkedInAnalyticsXlsx, LinkedInAnalyticsParseError } from './linkedinAnalyticsParser';
import { calculateLinkedInMetrics } from './linkedinAnalyticsMetrics';

function workbook(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Analytics');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('parses label-driven LinkedIn exports with moved rows and empty demographics', () => {
  const data = parseLinkedInAnalyticsXlsx(workbook([
    ['Discovery'], ['Reporting period', 'Aug 1, 2026 - Aug 7, 2026'],
    ['Members reached', 75], ['Total impressions', 150], [],
    ['Date', 'Impressions', 'Engagements', 'New followers'],
    ['2026-08-01', 50, 5, 1], ['2026-08-02', 100, 10, 2], [],
    ['Post URL', 'Post Publish Date', 'Engagements', 'Impressions'],
    ['https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789', '2026-08-02', 10, 100],
    [], ['Industry', 'Percentage'],
  ]));
  assert.equal(data.discovery.impressions, 150);
  assert.equal(data.discovery.membersReached, 75);
  assert.equal(data.engagementByDay.length, 2);
  assert.equal(data.topPosts.length, 1);
  assert.deepEqual(data.demographics.industry, []);
  const metrics = calculateLinkedInMetrics(data);
  assert.equal(metrics.engagementRate, 10);
  assert.equal(metrics.newFollowers, 3);
  assert.equal(metrics.peakDay?.impressions, 100);
});

test('rejects workbooks without analytics data', () => {
  assert.throws(() => parseLinkedInAnalyticsXlsx(workbook([['hello', 'world']])), LinkedInAnalyticsParseError);
});
