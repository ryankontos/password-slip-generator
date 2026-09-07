"""SVG canvas for previewing the same drawing operations used by the PDF."""

from html import escape

from reportlab.pdfbase.pdfmetrics import stringWidth

from password_slips import (
    A4, MM, draw_slip, draw_cut_ticks, draw_footer, column_widths,
    generated_records, slips_per_page, summary_page_count, page_count,
)


class PreviewCanvas:
    def __init__(self):
        self.parts = []
        self.fill = "#000000"
        self.stroke = "#000000"
        self.line_width = 1
        self.font = "Helvetica"
        self.size = 12

    def setFillColor(self, color):
        self.fill = color.hexval().replace("0x", "#")

    def setStrokeColor(self, color):
        self.stroke = color.hexval().replace("0x", "#")

    def setLineWidth(self, width):
        self.line_width = width

    def setFont(self, font, size):
        self.font, self.size = font, size

    def rect(self, x, y, width, height, stroke=0, fill=0):
        self.parts.append(
            '<rect x="%g" y="%g" width="%g" height="%g" fill="%s" stroke="%s" stroke-width="%g"/>'
            % (x, A4[1] - y - height, width, height,
               self.fill if fill else "none", self.stroke if stroke else "none", self.line_width)
        )

    def line(self, x1, y1, x2, y2):
        self.parts.append(
            '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="%g"/>'
            % (x1, A4[1] - y1, x2, A4[1] - y2, self.stroke, self.line_width)
        )

    def drawCentredString(self, x, y, text):
        self.text(x, y, text, "middle")

    def drawString(self, x, y, text):
        self.text(x, y, text, "start")

    def text(self, x, y, text, anchor):
        if not text:
            return
        family = "Courier New, monospace" if self.font.startswith("Courier") else (
            "Times New Roman, serif" if self.font.startswith("Times") else "Helvetica, Arial, sans-serif")
        self.parts.append(
            '<text x="%g" y="%g" fill="%s" font-family="%s" font-size="%g" '
            'font-weight="%s" font-style="%s" text-anchor="%s" '
            'textLength="%g" lengthAdjust="spacingAndGlyphs">%s</text>'
            % (x, A4[1] - y, self.fill, family, self.size,
               "bold" if "Bold" in self.font else "normal",
               "italic" if "Italic" in self.font or "Oblique" in self.font else "normal",
               anchor, stringWidth(text, self.font, self.size), escape(text))
        )


def preview_page(settings, data, page, generated_at):
    records = generated_records(settings, data)
    per_page = slips_per_page(settings)
    slip_pages = page_count(settings, len(records))
    summary_pages = summary_page_count(settings, len(data)) if settings.show_summary else 0
    page = min(max(0, page), max(0, slip_pages - 1))
    pdf = PreviewCanvas()
    width = A4[0] - settings.side_margin_mm * MM * 2
    area = width - settings.column_gap_mm * MM * (len(settings.columns) - 1)
    for slot, row in enumerate(records[page * per_page:(page + 1) * per_page]):
        draw_slip(pdf, settings, row, column_widths(settings.columns, row, settings, area),
                  settings.side_margin_mm * MM,
                  A4[1] - settings.top_margin_mm * MM - slot * settings.slip_height_mm * MM, width)
    if settings.show_cut_ticks:
        draw_cut_ticks(pdf, settings, *A4, per_page)
    draw_footer(pdf, settings, summary_pages + page + 1, summary_pages + slip_pages, generated_at, A4[0])
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" role="img" aria-label="Slip page preview">%s</svg>' % (*A4, "".join(pdf.parts))
    return {"svg": svg, "page": page, "slipPages": slip_pages,
            "pages": summary_pages + slip_pages, "rows": len(data),
            "slips": len(records), "perPage": per_page}
