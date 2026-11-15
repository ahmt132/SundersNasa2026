// Minimal .xlsx writer for the downloads. A real Excel workbook avoids the problems of CSV in
// Excel: no separator or decimal-mark confusion (e.g. Turkish Windows expects ";" and ","),
// letters such as "ü" always read correctly, and numbers are stored as numbers.
// Rows are written into the zip in batches, so large exports (500,000 hotspots) do not build one
// huge string in memory.
import { Zip, ZipDeflate, strToU8 } from "fflate";

export type Cell = string | number | null;

export interface Sheet {
  name: string; // at most 31 characters, no []:*?/\
  header: string[];
  rows: Cell[][];
  decimals?: Record<string, number>; // round these columns to n decimals
  widths?: number[]; // column widths in characters
  freezeHeader?: boolean;
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const BATCH = 5000;

const esc = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cell(v: Cell, dec: number | undefined, style: string): string {
  if (v == null || v === "") return "<c/>";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "<c/>";
    const n = dec == null ? v : Math.round(v * 10 ** dec) / 10 ** dec;
    return `<c${style}><v>${n}</v></c>`;
  }
  return `<c t="inlineStr"${style}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetHead(s: Sheet): string {
  const view = s.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : "";
  const cols = s.widths?.length
    ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const header = `<row>${s.header.map((h) => cell(h, undefined, ' s="1"')).join("")}</row>`;
  return `${XML}<worksheet xmlns="${NS}">${view}${cols}<sheetData>${header}`;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

export async function xlsxBlob(sheets: Sheet[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else parts.push(chunk);
  });
  const addText = (path: string, text: string) => {
    const f = new ZipDeflate(path, { level: 6 });
    zip.add(f);
    f.push(strToU8(text), true);
  };

  addText("[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    "</Types>");
  addText("_rels/.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  addText("xl/workbook.xml", `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>` +
    sheets.map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>");
  addText("xl/_rels/workbook.xml.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  // Style 0 = default, style 1 = bold (header row).
  addText("xl/styles.xml", `${XML}<styleSheet xmlns="${NS}">` +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');

  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const dec = s.header.map((h) => s.decimals?.[h]);
    const f = new ZipDeflate(`xl/worksheets/sheet${i + 1}.xml`, { level: 6 });
    zip.add(f);
    f.push(strToU8(sheetHead(s)));
    for (let r = 0; r < s.rows.length; r += BATCH) {
      const chunk = s.rows.slice(r, r + BATCH)
        .map((row) => `<row>${row.map((v, c) => cell(v, dec[c], "")).join("")}</row>`).join("");
      f.push(strToU8(chunk));
      if (s.rows.length > BATCH) await yieldToBrowser();
    }
    f.push(strToU8("</sheetData></worksheet>"), true);
  }
  zip.end();
  if (failure) throw failure;
  return new Blob(parts as BlobPart[], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
