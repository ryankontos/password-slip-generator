"""Workbook import, rule evaluation, and PDF rendering for Password Slip Studio."""

from __future__ import annotations

import csv
import base64
import io
import math
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable

from openpyxl import load_workbook
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


MM = 72 / 25.4
MAX_IMPORT_ROWS = 20_000
MAX_IMPORT_COLUMNS = 200
PAPER_SIZES = {"a4": A4, "letter": LETTER}
ROW_LAYOUT_KEYS = {
    "mode", "accent", "ink", "paperColor", "borderColor", "labelSize", "valueSize",
    "font", "labelCase", "fieldColumns", "labelPosition", "valueAlign", "labelWidth",
    "padding", "radius", "showBorder", "fieldLines", "zebra",
    "headerText", "subtitle", "footerText", "headerStyle", "logoData",
}


class StudioError(ValueError):
    """A user-facing validation failure."""


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="minutes")
    return str(value)


def unique_headers(values: Iterable[Any]) -> list[str]:
    headers: list[str] = []
    counts: dict[str, int] = {}
    for index, raw in enumerate(values, start=1):
        base = clean_cell(raw).strip() or f"Column {index}"
        counts[base] = counts.get(base, 0) + 1
        headers.append(base if counts[base] == 1 else f"{base} ({counts[base]})")
    return headers


def parse_workbook(filename: str, content: bytes) -> dict[str, Any]:
    """Return every visible worksheet as JSON-friendly headers and rows."""
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if suffix == "csv":
        return {"filename": filename, "sheets": [_parse_csv(content)]}
    if suffix not in {"xlsx", "xlsm"}:
        raise StudioError("Choose a .xlsx, .xlsm, or .csv file.")
    try:
        workbook = load_workbook(io.BytesIO(content), data_only=True, read_only=False)
    except Exception as exc:
        raise StudioError("That workbook could not be read.") from exc
    sheets = []
    try:
        for sheet in workbook.worksheets:
            if sheet.sheet_state != "visible":
                continue
            rows: list[list[str]] = []
            iterator = sheet.iter_rows(values_only=True)
            first = next(iterator, ())
            headers = unique_headers(first[:MAX_IMPORT_COLUMNS])
            for row_number, row in enumerate(iterator, start=2):
                dimension = sheet.row_dimensions.get(row_number)
                if dimension and dimension.hidden:
                    continue
                values = [clean_cell(value) for value in row[: len(headers)]]
                if any(value.strip() for value in values):
                    rows.append(values)
                if len(rows) >= MAX_IMPORT_ROWS:
                    break
            sheets.append({
                "name": sheet.title,
                "headers": headers,
                "rows": rows,
                "truncated": len(rows) >= MAX_IMPORT_ROWS,
            })
    finally:
        workbook.close()
    if not sheets:
        raise StudioError("The workbook has no visible sheets.")
    return {"filename": filename, "sheets": sheets}


def _parse_csv(content: bytes) -> dict[str, Any]:
    text = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            text = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise StudioError("The CSV text encoding could not be read.")
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    first = next(reader, [])
    headers = unique_headers(first[:MAX_IMPORT_COLUMNS])
    rows = []
    for row in reader:
        values = [clean_cell(value) for value in row[: len(headers)]]
        values.extend([""] * (len(headers) - len(values)))
        if any(value.strip() for value in values):
            rows.append(values)
        if len(rows) >= MAX_IMPORT_ROWS:
            break
    return {"name": "CSV", "headers": headers, "rows": rows, "truncated": len(rows) >= MAX_IMPORT_ROWS}


def condition_matches(condition: dict[str, Any], values: dict[str, Any]) -> bool:
    actual = clean_cell(values.get(str(condition.get("field", "")), ""))
    expected = clean_cell(condition.get("value", ""))
    operator = str(condition.get("operator", "not_empty"))
    left = actual.casefold()
    right = expected.casefold()
    if operator == "not_empty":
        return bool(actual.strip())
    if operator == "empty":
        return not actual.strip()
    if operator == "equals":
        return left == right
    if operator == "not_equals":
        return left != right
    if operator == "contains":
        return right in left
    if operator == "not_contains":
        return right not in left
    if operator == "starts_with":
        return left.startswith(right)
    if operator == "ends_with":
        return left.endswith(right)
    if operator == "greater_than":
        try:
            return float(actual) > float(expected)
        except ValueError:
            return False
    if operator == "less_than":
        try:
            return float(actual) < float(expected)
        except ValueError:
            return False
    if operator == "matches":
        try:
            return bool(re.search(expected, actual, flags=re.IGNORECASE))
        except re.error:
            return False
    return False


def rule_matches(rule: dict[str, Any], values: dict[str, Any]) -> bool:
    conditions = rule.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        return False
    results = [condition_matches(item, values) for item in conditions if isinstance(item, dict)]
    if not results:
        return False
    matched = any(results) if rule.get("match") == "any" else all(results)
    return not matched if rule.get("negate") else matched


def included_rows(state: dict[str, Any]) -> list[dict[str, Any]]:
    rules = [rule for rule in state.get("rules", []) if rule.get("enabled", True)]
    include_rules = [rule for rule in rules if rule.get("action") == "include_row"]
    exclude_rules = [rule for rule in rules if rule.get("action") == "exclude_row"]
    result = []
    for row in state.get("rows", []):
        if row.get("disabled"):
            continue
        values = row.get("values", {})
        if any(rule_matches(rule, values) for rule in exclude_rules):
            continue
        if include_rules and not any(rule_matches(rule, values) for rule in include_rules):
            continue
        result.append(row)
    return result


def visible_columns(state: dict[str, Any], row: dict[str, Any]) -> list[dict[str, Any]]:
    values = row.get("values", {})
    overrides = row.get("overrides", {})
    active_rules = [rule for rule in state.get("rules", []) if rule.get("enabled", True)]
    visible = []
    for column in state.get("columns", []):
        column_id = str(column.get("id", ""))
        mode = column.get("visibility", "always")
        keep_empty = bool(state.get("layout", {}).get("showBlankFields", False))
        shown = mode == "always" or (mode == "nonempty" and (keep_empty or bool(clean_cell(values.get(column_id, "")).strip())))
        for rule in active_rules:
            if rule.get("target") != column_id or not rule_matches(rule, values):
                continue
            if rule.get("action") == "show_field":
                shown = True
            elif rule.get("action") == "hide_field":
                shown = False
        if overrides.get(column_id) is True:
            shown = True
        elif overrides.get(column_id) is False:
            shown = False
        if shown:
            visible.append(column)
    override = row.get("layoutOverride")
    order = override.get("columnOrder") if isinstance(override, dict) else None
    if not isinstance(order, list) or not order:
        return visible
    explicit = {str(column_id): index for index, column_id in enumerate(order)}
    global_order = {str(column.get("id", "")): index for index, column in enumerate(state.get("columns", []))}
    return sorted(
        visible,
        key=lambda column: explicit.get(
            str(column.get("id", "")),
            len(order) + global_order.get(str(column.get("id", "")), len(global_order)),
        ),
    )


@dataclass
class PdfLayout:
    mode: str
    page_size: tuple[float, float]
    margin: float
    gap: float
    across: int
    slip_height: float
    accent: HexColor
    ink: HexColor
    muted: HexColor
    border: HexColor
    paper_color: HexColor
    label_size: float
    value_size: float
    font: str
    label_case: str
    field_columns: int
    label_position: str
    value_align: str
    label_width: float
    padding: float
    radius: float
    show_border: bool
    cut_marks: bool
    footer: bool
    field_lines: bool
    zebra: bool
    header_text: str
    subtitle: str
    footer_text: str
    header_style: str
    logo_data: str


def _number(value: Any, default: float, low: float, high: float) -> float:
    try:
        return min(high, max(low, float(value)))
    except (TypeError, ValueError):
        return default


def _hex(value: Any, default: str) -> HexColor:
    try:
        return HexColor(str(value))
    except (TypeError, ValueError):
        return HexColor(default)


def pdf_layout(state: dict[str, Any]) -> PdfLayout:
    source = state.get("layout", {})
    page = PAPER_SIZES.get(str(source.get("paper", "a4")), A4)
    if source.get("orientation") == "landscape":
        page = (page[1], page[0])
    return PdfLayout(
        mode=str(source.get("mode", "grid")),
        page_size=page,
        margin=_number(source.get("margin", 10), 10, 2, 40) * MM,
        gap=_number(source.get("gap", 3), 3, 0, 20) * MM,
        across=int(_number(source.get("across", 1), 1, 1, 3)),
        slip_height=_number(source.get("slipHeight", 42), 42, 20, 120) * MM,
        accent=_hex(source.get("accent"), "#185ADB"),
        ink=_hex(source.get("ink"), "#151719"),
        muted=_hex(source.get("muted"), "#687078"),
        border=_hex(source.get("borderColor"), "#C9CED4"),
        paper_color=_hex(source.get("paperColor"), "#FFFFFF"),
        label_size=_number(source.get("labelSize", 8), 8, 4, 18),
        value_size=_number(source.get("valueSize", 12), 12, 5, 26),
        font=str(source.get("font", "Helvetica")) if source.get("font") in {"Helvetica", "Times-Roman", "Courier"} else "Helvetica",
        label_case=str(source.get("labelCase", "upper")),
        field_columns=int(_number(source.get("fieldColumns", 0), 0, 0, 5)),
        label_position=str(source.get("labelPosition", "preset")),
        value_align=str(source.get("valueAlign", "left")),
        label_width=_number(source.get("labelWidth", 36), 36, 18, 60) / 100,
        padding=_number(source.get("padding", 2), 2, 0, 10) * MM,
        radius=_number(source.get("radius", 0), 0, 0, 8) * MM,
        show_border=bool(source.get("showBorder", True)),
        cut_marks=bool(source.get("cutMarks", True)),
        footer=bool(source.get("footer", True)),
        field_lines=bool(source.get("fieldLines", True)),
        zebra=bool(source.get("zebra", False)),
        header_text=clean_cell(source.get("headerText", "")),
        subtitle=clean_cell(source.get("subtitle", "")),
        footer_text=clean_cell(source.get("footerText", "")),
        header_style=str(source.get("headerStyle", "line")) if source.get("headerStyle") in {"line", "band", "box"} else "line",
        logo_data=clean_cell(source.get("logoData", "")) if re.fullmatch(r"data:image/(?:png|jpeg);base64,[A-Za-z0-9+/=]+", clean_cell(source.get("logoData", "")), flags=re.IGNORECASE) else "",
    )


def row_pdf_layout(state: dict[str, Any], row: dict[str, Any], base: PdfLayout) -> PdfLayout:
    """Return the sheet layout with safe, slip-only overrides for one row."""
    override = row.get("layoutOverride")
    if not isinstance(override, dict):
        return base
    values = dict(state.get("layout", {}))
    values.update({key: value for key, value in override.items() if key in ROW_LAYOUT_KEYS})
    return pdf_layout({**state, "layout": values})


def render_pdf(state: dict[str, Any]) -> bytes:
    rows = included_rows(state)
    if not rows:
        raise StudioError("There are no included rows to export.")
    columns = state.get("columns", [])
    if not columns:
        raise StudioError("Add at least one column before exporting.")
    layout = pdf_layout(state)
    width, height = layout.page_size
    footer_height = 7 * MM if layout.footer else 0
    usable_width = width - 2 * layout.margin
    slip_width = (usable_width - layout.gap * (layout.across - 1)) / layout.across
    usable_height = height - 2 * layout.margin - footer_height
    down = int((usable_height + layout.gap) // (layout.slip_height + layout.gap))
    if down < 1:
        raise StudioError("The slip height and page margins do not fit on the selected paper.")
    per_page = layout.across * down
    pages = math.ceil(len(rows) / per_page)
    stream = io.BytesIO()
    pdf = canvas.Canvas(stream, pagesize=layout.page_size, pageCompression=1)
    pdf.setTitle(str(state.get("name") or "Password Slip Studio"))
    for page_index in range(pages):
        page_rows = rows[page_index * per_page : (page_index + 1) * per_page]
        for index, row in enumerate(page_rows):
            grid_index = index
            if state.get("layout", {}).get("flow") == "columns":
                grid_index = (index % down) * layout.across + index // down
            column_index = grid_index % layout.across
            row_index = grid_index // layout.across
            x = layout.margin + column_index * (slip_width + layout.gap)
            top = height - layout.margin - row_index * (layout.slip_height + layout.gap)
            slip_layout = row_pdf_layout(state, row, layout)
            _draw_slip(pdf, state, row, visible_columns(state, row), slip_layout, x, top - layout.slip_height, slip_width, layout.slip_height)
        if layout.cut_marks:
            _draw_cut_marks(pdf, layout, width, height, slip_width, down)
        if layout.footer:
            pdf.setFillColor(layout.muted)
            pdf.setFont("Helvetica", 7)
            left = str(state.get("name") or "Password Slip Studio")
            pdf.drawString(layout.margin, 4.5 * MM, left[:80])
            pdf.drawRightString(width - layout.margin, 4.5 * MM, f"Page {page_index + 1} of {pages}")
        pdf.showPage()
    pdf.save()
    return stream.getvalue()


def _draw_cut_marks(pdf: canvas.Canvas, layout: PdfLayout, width: float, height: float, slip_width: float, down: int) -> None:
    pdf.saveState()
    pdf.setStrokeColor(layout.border)
    pdf.setLineWidth(0.35)
    tick = 3 * MM
    for row_index in range(down + 1):
        y = height - layout.margin - row_index * (layout.slip_height + layout.gap)
        pdf.line(0, y, tick, y)
        pdf.line(width - tick, y, width, y)
    if layout.across > 1:
        for column_index in range(1, layout.across):
            x = layout.margin + column_index * slip_width + (column_index - 0.5) * layout.gap
            pdf.line(x, height, x, height - tick)
            pdf.line(x, 0, x, tick)
    pdf.restoreState()


def _font_for(column: dict[str, Any], layout: PdfLayout) -> str:
    style = column.get("style")
    if style == "mono" or column.get("type") == "password":
        return "Courier-Bold"
    if style == "strong":
        return {"Helvetica": "Helvetica-Bold", "Times-Roman": "Times-Bold", "Courier": "Courier-Bold"}.get(layout.font, "Helvetica-Bold")
    return layout.font


def _label_font(layout: PdfLayout) -> str:
    return {"Helvetica": "Helvetica-Bold", "Times-Roman": "Times-Bold", "Courier": "Courier-Bold"}.get(layout.font, "Helvetica-Bold")


def _label(value: Any, layout: PdfLayout) -> str:
    text = clean_cell(value)
    if layout.label_case == "upper":
        return text.upper()
    if layout.label_case == "title":
        return text.title()
    return text


def _display_value(column: dict[str, Any], value: Any) -> str:
    text = clean_cell(value)
    transform = str(column.get("valueTransform", "as_entered"))
    if transform == "upper":
        return text.upper()
    if transform == "lower":
        return text.lower()
    if transform == "title":
        return text.title()
    if transform == "mask_last4" and len(text) > 4:
        return "•" * max(4, len(text) - 4) + text[-4:]
    return text


def _value_align(column: dict[str, Any], layout: PdfLayout) -> str:
    alignment = column.get("valueAlign")
    return alignment if alignment in {"left", "center", "right"} else layout.value_align


def _blend(first: Color, second: Color, amount: float) -> Color:
    return Color(
        first.red * (1 - amount) + second.red * amount,
        first.green * (1 - amount) + second.green * amount,
        first.blue * (1 - amount) + second.blue * amount,
    )


def _fit(text: str, font: str, size: float, width: float, minimum: float = 4) -> tuple[str, float]:
    if not text:
        return "", size
    measured = stringWidth(text, font, size)
    fitted = max(minimum, min(size, size * width / measured)) if measured else size
    if fitted > minimum or stringWidth(text, font, fitted) <= width:
        return text, fitted
    suffix = "…"
    while text and stringWidth(text + suffix, font, fitted) > width:
        text = text[:-1]
    return text + suffix, fitted


def _text(pdf: canvas.Canvas, text: Any, font: str, size: float, color: Color, x: float, baseline: float, width: float, align: str = "left") -> None:
    cleaned, fitted = _fit(clean_cell(text), font, size, max(1, width))
    pdf.setFillColor(color)
    pdf.setFont(font, fitted)
    if align == "center":
        pdf.drawCentredString(x + width / 2, baseline, cleaned)
    elif align == "right":
        pdf.drawRightString(x + width, baseline, cleaned)
    else:
        pdf.drawString(x, baseline, cleaned)


def _logo_reader(data: str) -> ImageReader | None:
    match = re.fullmatch(r"data:image/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)", clean_cell(data), flags=re.IGNORECASE)
    if not match:
        return None
    try:
        return ImageReader(io.BytesIO(base64.b64decode(match.group(1), validate=True)))
    except Exception:
        return None


def _draw_logo(pdf: canvas.Canvas, reader: ImageReader, x: float, y: float, max_width: float, max_height: float) -> float:
    image_width, image_height = reader.getSize()
    if not image_width or not image_height:
        return 0
    scale = min(max_width / image_width, max_height / image_height)
    width = image_width * scale
    height = image_height * scale
    pdf.drawImage(reader, x, y + (max_height - height) / 2, width=width, height=height, preserveAspectRatio=True, mask="auto")
    return width


def _draw_slip(pdf: canvas.Canvas, state: dict[str, Any], row: dict[str, Any], columns: list[dict[str, Any]], layout: PdfLayout, x: float, y: float, width: float, height: float) -> None:
    pdf.saveState()
    pdf.setFillColor(layout.paper_color)
    pdf.setStrokeColor(layout.border)
    pdf.setLineWidth(0.6)
    if layout.radius:
        pdf.roundRect(x, y, width, height, layout.radius, fill=1, stroke=int(layout.show_border))
    else:
        pdf.rect(x, y, width, height, fill=1, stroke=int(layout.show_border))
    values = row.get("values", {})
    logo_reader = _logo_reader(layout.logo_data)
    header_height = 14 * MM if logo_reader else (10 * MM if layout.header_text or layout.subtitle else 0)
    footer_height = 6 * MM if layout.footer_text else 0
    if header_height:
        padding = max(layout.padding, 2 * MM)
        header_y = y + height - header_height
        if layout.header_style == "band":
            pdf.setFillColor(layout.accent)
            pdf.rect(x, header_y, width, header_height, fill=1, stroke=0)
            heading_color = HexColor("#FFFFFF")
            subtitle_color = HexColor("#E8EEFF")
        elif layout.header_style == "box":
            pdf.setStrokeColor(layout.accent)
            pdf.setLineWidth(0.7)
            pdf.roundRect(x + 1 * MM, header_y + 1 * MM, width - 2 * MM, header_height - 1.5 * MM, min(layout.radius or 1.5 * MM, 2 * MM), fill=0, stroke=1)
            heading_color = layout.ink
            subtitle_color = layout.muted
        else:
            pdf.setStrokeColor(layout.accent)
            pdf.setLineWidth(1.2)
            pdf.line(x + padding, header_y, x + width - padding, header_y)
            heading_color = layout.ink
            subtitle_color = layout.muted
        text_x = x + padding
        text_width = width - padding * 2
        if logo_reader:
            logo_width = _draw_logo(pdf, logo_reader, text_x, header_y + 2.5 * MM, 12 * MM, header_height - 5 * MM)
            text_x += logo_width + 2 * MM
            text_width = max(1, width - (text_x - x) - padding)
        if layout.header_text:
            _text(pdf, layout.header_text, _label_font(layout), max(6, layout.label_size), heading_color, text_x, header_y + 7.2 * MM if logo_reader else header_y + 5.2 * MM, text_width)
        if layout.subtitle:
            _text(pdf, layout.subtitle, layout.font, max(5, layout.label_size - 1), subtitle_color, text_x, header_y + 4.2 * MM if logo_reader else header_y + 2.2 * MM, text_width)
    if footer_height:
        padding = max(layout.padding, 2 * MM)
        pdf.setStrokeColor(layout.border)
        pdf.setLineWidth(0.35)
        pdf.line(x + padding, y + footer_height, x + width - padding, y + footer_height)
        _text(pdf, layout.footer_text, layout.font, 6, layout.muted, x + padding, y + 2.1 * MM, width - padding * 2)
    content_y = y + footer_height
    content_height = max(1, height - header_height - footer_height)
    if not columns:
        pdf.setFillColor(layout.muted)
        pdf.setFont("Helvetica-Oblique", layout.value_size)
        pdf.drawCentredString(x + width / 2, content_y + content_height / 2, "Blank slip")
        pdf.restoreState()
        return
    mode = layout.mode
    if mode == "horizontal":
        _draw_horizontal(pdf, values, columns, layout, x, content_y, width, content_height)
    elif mode == "stacked":
        _draw_stacked(pdf, values, columns, layout, x, content_y, width, content_height)
    elif mode == "hero":
        _draw_hero(pdf, values, columns, layout, x, content_y, width, content_height)
    else:
        defaults = {
            "grid": (2, "top"),
            "compact": (3, "inline"),
            "dense": (4, "top"),
            "cards": (2, "top"),
            "ledger": (2, "left"),
        }
        across, position = defaults.get(mode, (2, "top"))
        _draw_matrix(
            pdf, values, columns, layout, x, content_y, width, content_height,
            layout.field_columns or across,
            position if layout.label_position == "preset" else layout.label_position,
            cards=mode == "cards",
        )
    pdf.restoreState()


def _draw_horizontal(pdf: canvas.Canvas, values: dict[str, Any], columns: list[dict[str, Any]], layout: PdfLayout, x: float, y: float, width: float, height: float) -> None:
    label_height = min(height * 0.42, max(10 * MM, layout.label_size * 2.1))
    weights = [max(0.5, _number(column.get("width", 1), 1, 0.5, 3)) for column in columns]
    total = sum(weights)
    cursor = x
    for index, (column, weight) in enumerate(zip(columns, weights)):
        cell_width = width * weight / total
        pdf.setFillColor(layout.accent)
        pdf.rect(cursor, y + height - label_height, cell_width, label_height, fill=1, stroke=0)
        padding = max(layout.padding, 1 * MM)
        _text(pdf, _label(column.get("label", ""), layout), _label_font(layout), layout.label_size, HexColor("#FFFFFF"), cursor + padding, y + height - label_height + (label_height - layout.label_size) / 2, cell_width - padding * 2, "center")
        _text(pdf, _display_value(column, values.get(column.get("id"), "")), _font_for(column, layout), layout.value_size, layout.ink, cursor + padding, y + (height - label_height - layout.value_size) / 2, cell_width - padding * 2, _value_align(column, layout))
        if index and layout.field_lines:
            pdf.setStrokeColor(layout.border)
            pdf.line(cursor, y, cursor, y + height)
        cursor += cell_width


def _draw_stacked(pdf: canvas.Canvas, values: dict[str, Any], columns: list[dict[str, Any]], layout: PdfLayout, x: float, y: float, width: float, height: float) -> None:
    row_height = height / len(columns)
    label_width = min(width * layout.label_width, 55 * MM)
    for index, column in enumerate(columns):
        bottom = y + height - (index + 1) * row_height
        if index and layout.field_lines:
            pdf.setStrokeColor(layout.border)
            pdf.line(x, bottom + row_height, x + width, bottom + row_height)
        pdf.setFillColor(layout.accent)
        pdf.rect(x, bottom, label_width, row_height, fill=1, stroke=0)
        baseline = bottom + (row_height - layout.label_size) / 2
        padding = max(layout.padding, 1 * MM)
        _text(pdf, _label(column.get("label", ""), layout), _label_font(layout), layout.label_size, HexColor("#FFFFFF"), x + padding, baseline, label_width - padding * 2)
        _text(pdf, _display_value(column, values.get(column.get("id"), "")), _font_for(column, layout), layout.value_size, layout.ink, x + label_width + padding, bottom + (row_height - layout.value_size) / 2, width - label_width - padding * 2, _value_align(column, layout))


def _draw_matrix(pdf: canvas.Canvas, values: dict[str, Any], columns: list[dict[str, Any]], layout: PdfLayout, x: float, y: float, width: float, height: float, across: int, position: str, *, cards: bool = False) -> None:
    across = min(across, len(columns))
    down = math.ceil(len(columns) / across)
    slot_weights = [max(0.5, _number(columns[index].get("width", 1), 1, 0.5, 3)) for index in range(across)]
    total_weight = sum(slot_weights)
    slot_widths = [width * weight / total_weight for weight in slot_weights]
    slot_lefts = [x]
    for slot_width in slot_widths[:-1]:
        slot_lefts.append(slot_lefts[-1] + slot_width)
    cell_height = height / down
    inset = 1 * MM if cards else 0
    label_font = _label_font(layout)
    for index, column in enumerate(columns):
        col = index % across
        row = index // across
        cell_width = slot_widths[col]
        left = slot_lefts[col] + inset
        bottom = y + height - (row + 1) * cell_height + inset
        draw_width = cell_width - inset * 2
        draw_height = cell_height - inset * 2
        if layout.zebra and index % 2:
            pdf.setFillColor(_blend(layout.paper_color, layout.accent, 0.06))
            if cards or layout.radius:
                pdf.roundRect(left, bottom, draw_width, draw_height, min(layout.radius or 1.5 * MM, draw_height / 4), fill=1, stroke=0)
            else:
                pdf.rect(left, bottom, draw_width, draw_height, fill=1, stroke=0)
        if cards:
            pdf.setStrokeColor(layout.border)
            pdf.roundRect(left, bottom, draw_width, draw_height, min(layout.radius or 1.5 * MM, draw_height / 4), fill=0, stroke=1)
        elif layout.field_lines and col:
            pdf.setStrokeColor(layout.border)
            pdf.line(slot_lefts[col], y + height - (row + 1) * cell_height, slot_lefts[col], y + height - row * cell_height)
        if not cards and layout.field_lines and row:
            pdf.setStrokeColor(layout.border)
            pdf.line(slot_lefts[col], y + height - row * cell_height, slot_lefts[col] + cell_width, y + height - row * cell_height)
        padding = max(layout.padding, 0.6 * MM)
        content_x = left + padding
        content_width = max(1, draw_width - padding * 2)
        label = _label(column.get("label", ""), layout)
        if position == "inline":
            label = f"{label}:"
            label_width = min(content_width * layout.label_width, stringWidth(label, label_font, layout.label_size) + 2 * MM)
            baseline = bottom + (draw_height - layout.value_size) / 2
            _text(pdf, label, label_font, layout.label_size, layout.accent, content_x, baseline, label_width)
            _text(pdf, _display_value(column, values.get(column.get("id"), "")), _font_for(column, layout), layout.value_size, layout.ink, content_x + label_width + 1 * MM, baseline, content_width - label_width - 1 * MM, _value_align(column, layout))
        elif position == "left":
            label_width = content_width * layout.label_width
            baseline = bottom + (draw_height - layout.value_size) / 2
            _text(pdf, label, label_font, layout.label_size, layout.accent, content_x, baseline, label_width)
            _text(pdf, _display_value(column, values.get(column.get("id"), "")), _font_for(column, layout), layout.value_size, layout.ink, content_x + label_width + 1 * MM, baseline, content_width - label_width - 1 * MM, _value_align(column, layout))
        else:
            _text(pdf, label, label_font, layout.label_size, layout.accent, content_x, bottom + draw_height - layout.label_size - padding, content_width)
            _text(pdf, _display_value(column, values.get(column.get("id"), "")), _font_for(column, layout), layout.value_size, layout.ink, content_x, bottom + padding, content_width, _value_align(column, layout))


def _draw_hero(pdf: canvas.Canvas, values: dict[str, Any], columns: list[dict[str, Any]], layout: PdfLayout, x: float, y: float, width: float, height: float) -> None:
    primary = columns[0]
    hero_height = height * 0.42
    pdf.setFillColor(layout.accent)
    pdf.rect(x, y + height - hero_height, width, hero_height, fill=1, stroke=0)
    padding = max(layout.padding, 1.5 * MM)
    _text(pdf, _label(primary.get("label", ""), layout), _label_font(layout), layout.label_size, HexColor("#E8EEFF"), x + padding, y + height - layout.label_size - padding, width - padding * 2)
    _text(pdf, _display_value(primary, values.get(primary.get("id"), "")), _font_for(primary, layout), layout.value_size * 1.28, HexColor("#FFFFFF"), x + padding, y + height - hero_height + padding, width - padding * 2, _value_align(primary, layout))
    remaining = columns[1:]
    if remaining:
        position = "top" if layout.label_position == "preset" else layout.label_position
        _draw_matrix(pdf, values, remaining, layout, x, y, width, height - hero_height, layout.field_columns or 2, position)
