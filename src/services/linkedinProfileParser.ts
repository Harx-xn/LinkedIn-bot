import { PDFParse } from 'pdf-parse';

export type LinkedInProfileSnapshotData={name?:string;headline?:string;location?:string;summary?:string;skills:string[];experience:string[];education:string[];linkedinUrl?:string};
export async function parseLinkedInProfilePdf(buffer: Buffer): Promise<LinkedInProfileSnapshotData> {
  const parser=new PDFParse({data:new Uint8Array(buffer)});
  try {
    const result=await parser.getText(); const lines=result.text.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    if (!lines.length) throw new Error('No selectable text was found in the PDF.');
    const section=(name:string,next:string[])=>{const start=lines.findIndex(v=>v.toLowerCase()===name); if(start<0)return[]; let end=lines.length; for(let i=start+1;i<lines.length;i++)if(next.includes(lines[i].toLowerCase())){end=i;break;} return lines.slice(start+1,end);};
    const headings=['about','experience','education','skills','licenses & certifications','contact'];
    const about=section('about',headings); const skills=section('skills',headings).slice(0,30); const experience=section('experience',headings).slice(0,50); const education=section('education',headings).slice(0,30);
    const url=result.text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)]+/i)?.[0];
    return {name:lines[0],headline:lines[1],location:lines.slice(2,6).find(v=>/,| area| pakistan| united| uk| india/i.test(v)),summary:about.join('\n')||undefined,skills,experience,education,linkedinUrl:url};
  } finally { await parser.destroy(); }
}

