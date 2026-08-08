import * as XLSX from 'xlsx';
import type { NormalizedLinkedInAnalytics } from './linkedinAnalyticsTypes';

export class LinkedInAnalyticsParseError extends Error {}
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
const key = (v: unknown) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const parsed = Number(clean(v).replace(/[%,$\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const iso = (v: unknown): string | undefined => {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v); if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d)).toISOString();
  }
  const d = new Date(clean(v)); return isNaN(d.getTime()) ? undefined : d.toISOString();
};

function headerMap(row: unknown[]) { const m = new Map<string, number>(); row.forEach((v, i) => m.set(key(v), i)); return m; }
function findHeader(rows: unknown[][], required: string[]) {
  for (let i=0;i<rows.length;i++) { const m=headerMap(rows[i]); if (required.every(r=>m.has(r))) return { index:i, map:m }; }
  return undefined;
}
function labelValue(rows: unknown[][], labels: string[]) {
  for (const row of rows) for (let i=0;i<row.length;i++) if (labels.includes(key(row[i]))) {
    for (let j=i+1;j<row.length;j++) if (clean(row[j])) return num(row[j]);
    const next = rows[rows.indexOf(row)+1]; if (next?.[i] != null) return num(next[i]);
  }
  return 0;
}
function detectPeriod(rows: unknown[][], dates: string[]) {
  const all = [...dates];
  for (const row of rows) for (let i=0;i<row.length;i++) if (/reporting period|date range/.test(key(row[i]))) {
    for (const cell of row.slice(i+1)) {
      const matches=clean(cell).match(/[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/g) ?? [];
      matches.map(iso).filter(Boolean).forEach(v=>all.push(v!));
    }
  }
  all.sort(); if (!all.length) throw new LinkedInAnalyticsParseError('The reporting period could not be detected.');
  return { start: all[0], end: all[all.length-1] };
}

export function parseLinkedInAnalyticsXlsx(buffer: Buffer): NormalizedLinkedInAnalytics {
  let workbook: XLSX.WorkBook;
  try { workbook=XLSX.read(buffer,{type:'buffer',cellDates:true}); } catch { throw new LinkedInAnalyticsParseError('This file is not a valid XLSX workbook.'); }
  const rows: unknown[][]=[];
  workbook.SheetNames.forEach(name=>rows.push(...XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,defval:null,raw:true}) as unknown[][]));
  if (!rows.length) throw new LinkedInAnalyticsParseError('The LinkedIn export is empty.');

  const daily: NormalizedLinkedInAnalytics['engagementByDay']=[];
  for (let i=0;i<rows.length;i++) { const m=headerMap(rows[i]); const di=m.get('date'); const ii=m.get('impressions');
    if (di==null||ii==null||m.has('post url')) continue; const ei=m.get('engagements'); const fi=m.get('new followers');
    for (let j=i+1;j<rows.length;j++) { const date=iso(rows[j][di]); if (!date) break; daily.push({date,impressions:Math.round(num(rows[j][ii])),engagements:Math.round(num(ei==null?0:rows[j][ei])),...(fi==null?{}:{newFollowers:Math.round(num(rows[j][fi]))})}); }
  }
  const topPosts: NormalizedLinkedInAnalytics['topPosts']=[];
  const top=findHeader(rows,['post url','post publish date','engagements','impressions']);
  if (top) for (let j=top.index+1;j<rows.length;j++) { const url=clean(rows[j][top.map.get('post url')!]); if (!url) break; if (!/^https?:\/\//i.test(url)) continue; topPosts.push({url,publishedAt:iso(rows[j][top.map.get('post publish date')!]),engagements:Math.round(num(rows[j][top.map.get('engagements')!])),impressions:Math.round(num(rows[j][top.map.get('impressions')!]))}); }

  const demographics: NormalizedLinkedInAnalytics['demographics']={location:[],companySize:[],seniority:[],jobTitle:[],industry:[],company:[]};
  const aliases: Record<string,keyof typeof demographics>={'location':'location','company size':'companySize','seniority':'seniority','job title':'jobTitle','industry':'industry','company':'company'};
  let current: keyof typeof demographics | undefined;
  for (const row of rows) { const first=key(row.find(v=>clean(v))); if (aliases[first]) { current=aliases[first]; continue; } if (!current) continue;
    const vals=row.filter(v=>clean(v)); if (vals.length>=2) { const label=clean(vals[0]); const value=num(vals[1]); if (label && value>=0 && !/percentage|value|demographic/.test(key(label))) demographics[current].push({label,value}); }
  }
  const impressions=Math.round(labelValue(rows,['impressions','total impressions'])) || daily.reduce((s,d)=>s+d.impressions,0);
  const membersReached=Math.round(labelValue(rows,['members reached','total members reached']));
  const totalFollowers=Math.round(labelValue(rows,['total followers','followers']));
  const period=detectPeriod(rows,daily.map(d=>d.date).concat(topPosts.map(p=>p.publishedAt).filter(Boolean) as string[]));
  if (!impressions && !daily.length && !topPosts.length) throw new LinkedInAnalyticsParseError('Missing required LinkedIn analytics sections.');
  return {period,discovery:{impressions,membersReached},engagementByDay:daily,followers:{...(totalFollowers?{total:totalFollowers}:{}),new:daily.reduce((s,d)=>s+(d.newFollowers??0),0)},topPosts,demographics};
}

