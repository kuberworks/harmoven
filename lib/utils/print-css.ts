// lib/utils/print-css.ts
// Print CSS for the run result print export (handlePrint in ResultTab).
// Kept in a separate module so it can be loaded lazily via dynamic import()
// and excluded from the initial JS bundle for the run detail page.
// Loaded only when the user clicks the Print button.

export const PRINT_CSS = `
/* Margin strategy — all-browser reliable including Safari:
   LEFT/RIGHT: body { padding: 0 2.5cm } constrains content-box width so every
     line on every page is indented. @page margin-left/right = 0 to avoid double.
   TOP/BOTTOM: CSS table thead/tfoot trick. The browser repeats <thead> and <tfoot>
     natively at the top/bottom of EVERY printed page. Empty cells with a fixed
     height act as per-page top/bottom margins. This works in Safari, Chrome,
     Firefox, Edge — no @page support needed for margins. */
@page { margin: 0; }
*, *::before, *::after { box-sizing: border-box; }
html { margin: 0; padding: 0; background: white; }
body {
  margin: 0;
  padding: 0 2.5cm;
  background: white;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 11pt;
  line-height: 1.65;
  color: #111;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
table.print-layout { width: 100%; border-collapse: collapse; border: none; margin: 0; }
table.print-layout > thead > tr > td,
table.print-layout > tfoot > tr > td { height: 2cm; line-height: 0; font-size: 0; border: none !important; padding: 0 !important; background: transparent !important; }
table.print-layout > tbody > tr > td { border: none !important; padding: 0 !important; background: transparent !important; vertical-align: top; }
h1 { font-size: 20pt; margin: 0 0 14pt; color: #000; }
h2 { font-size: 15pt; margin: 18pt 0 8pt; color: #111; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; color: #111; }
h4, h5, h6 { font-size: 11pt; margin: 10pt 0 4pt; color: #333; }
p { margin: 0 0 8pt; }
ul, ol { padding-left: 20pt; margin: 0 0 8pt; }
li { margin-bottom: 3pt; }
blockquote { border-left: 3px solid #aaa; padding-left: 10pt; color: #444; font-style: italic; margin: 8pt 0; background: transparent; }
code { font-family: Consolas, 'Courier New', monospace; font-size: 9pt; background: #f4f4f4; color: #c00; border: 1px solid #ddd; border-radius: 2px; padding: 0 2pt; }
pre { font-family: Consolas, 'Courier New', monospace; font-size: 8.5pt; background: #f8f8f8; border: 1px solid #ccc; border-radius: 3px; padding: 8pt; white-space: pre-wrap; word-break: break-all; margin: 8pt 0; overflow: visible; }
pre code { background: transparent; border: none; color: inherit; font-size: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; margin: 8pt 0; }
th, td { border: 1px solid #bbb; padding: 4pt 8pt; text-align: left; background: transparent; }
th { background: #eee; font-weight: 700; }
a { color: #1a56db; text-decoration: underline; }
a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8pt; color: #666; word-break: break-all; }
h1, h2 { page-break-after: avoid; break-after: avoid; }
pre, blockquote, table { page-break-inside: avoid; break-inside: avoid; }
.section-label { font-family: monospace; font-size: 9pt; color: #666; margin: 0 0 16pt; }
.plain-text { white-space: pre-wrap; word-break: break-word; font-size: 11pt; }
`
