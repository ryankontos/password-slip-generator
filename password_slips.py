#!/usr/bin/env python3
"""Generate cut-aligned password slip PDFs from the newest Excel file in Downloads."""

from __future__ import annotations

import json
import math
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from openpyxl import load_workbook
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


APP_NAME = "password-slip-generator"
AUTHOR = "Ryan Kontos"
YEAR = "2026"
LICENSE_NAME = "0BSD"
SCRIPT_DIR = Path(__file__).resolve().parent
LAYOUT_FILE = SCRIPT_DIR / "layout_settings.json"
SETTINGS_FILE = SCRIPT_DIR / "settings.json"
MM = 72 / 25.4


@dataclass
class Settings:
    workbook: str = ""
    sheet: str = ""
    columns: list[str] = field(default_factory=list)
    column_numbers: list[int] = field(default_factory=list)
    output_folder: str = ""
    input_folder: str = ""
    default_action: str = "export"
    workbook_extensions: list[str] = field(default_factory=lambda: [".xlsx", ".xlsm"])

    header_height_mm: float = 20.0
    data_height_mm: float = 20.0
    top_margin_mm: float = 8.0
    bottom_margin_mm: float = 8.0
    side_margin_mm: float = 5.0
    column_gap_mm: float = 2.0
    padding_mm: float = 2.0
    cut_tick_mm: float = 4.0
    column_width_evenness: float = 0.55
    column_min_width_ratio: float = 0.07
    column_max_width_ratio: float = 0.45

    header_color: str = "#1769AA"
    header_font_pt: float = 11.0
    data_font_pt: float = 12.0
    minimum_font_pt: float = 4.0

    show_footer: bool = True
    show_sheet_name: bool = True
    show_generated_datetime: bool = True
    show_page_numbers: bool = True
    footer_font_pt: float = 7.5
    footer_color: str = "#555555"

    @property
    def slip_height_mm(self) -> float:
        return self.header_height_mm + self.data_height_mm


def downloads_folder() -> Path:
    return Path.home() / "Downloads"


def newest_workbook(folder: str, extensions: list[str]) -> Optional[Path]:
    folder = Path(folder).expanduser()
    if not folder.is_dir():
        return None

    allowed = {extension.lower() for extension in extensions}
    files = [
        file for file in folder.iterdir()
        if file.is_file()
        and file.suffix.lower() in allowed
        and not file.name.startswith((".", "~$"))
    ]
    return max(files, key=lambda file: file.stat().st_mtime) if files else None


def read_saved_settings() -> Settings:
    settings = Settings()
    ensure_json_files(settings)
    apply_saved_app_settings(settings)
    apply_saved_layout(settings)
    save_layout_file(settings)
    settings.input_folder = settings.input_folder or str(downloads_folder())
    settings.output_folder = settings.output_folder or str(downloads_folder())
    return settings


def ensure_json_files(defaults: Settings) -> None:
    if not LAYOUT_FILE.exists():
        save_layout_file(defaults)
    if not SETTINGS_FILE.exists():
        save_app_settings(defaults)


def apply_saved_app_settings(settings: Settings) -> None:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        save_app_settings(settings)
        data = {}

    settings.input_folder = str(data.get("input_folder") or "~/Downloads")
    settings.output_folder = str(data.get("output_folder") or "~/Downloads")
    settings.default_action = str(data.get("default_action") or "export").lower()
    if settings.default_action not in {"export", "print"}:
        settings.default_action = "export"

    extensions = data.get("workbook_extensions") or [".xlsx", ".xlsm"]
    settings.workbook_extensions = [str(extension).strip().lower() for extension in extensions]
    settings.column_numbers = [int(number) for number in data.get("column_numbers", [])]


def apply_saved_layout(settings: Settings) -> None:
    try:
        data = json.loads(LAYOUT_FILE.read_text(encoding="utf-8"))
        for key, value in data.items():
            if key in layout_field_names():
                setattr(settings, key, value)
        HexColor(settings.header_color)
    except (OSError, TypeError, ValueError):
        print(f"Could not read {LAYOUT_FILE.name}; using built-in layout defaults.")


def save_settings(settings: Settings) -> None:
    save_app_settings(settings)


def save_app_settings(settings: Settings) -> None:
    data = {
        "_help": app_settings_help(),
        "input_folder": settings.input_folder or "~/Downloads",
        "output_folder": settings.output_folder or "~/Downloads",
        "default_action": settings.default_action,
        "workbook_extensions": settings.workbook_extensions,
        "column_numbers": settings.column_numbers,
    }
    SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def save_layout_file(settings: Settings) -> None:
    layout = {"_help": layout_settings_help()}
    for name in layout_field_names():
        layout[name] = getattr(settings, name)
    LAYOUT_FILE.write_text(json.dumps(layout, indent=2), encoding="utf-8")


def app_settings_help() -> dict[str, str]:
    return {
        "input_folder": "Folder searched for the latest Excel workbook when you press Enter at the file prompt.",
        "output_folder": "Default folder for generated PDFs.",
        "default_action": "Default final action. Use export or print.",
        "workbook_extensions": "Excel file extensions to look for in input_folder.",
        "column_numbers": "Last selected column numbers, in the order they should appear on each slip.",
    }


def layout_settings_help() -> dict[str, str]:
    return {
        "header_height_mm": "Height of the blue header area on each slip.",
        "data_height_mm": "Height of the white data area on each slip.",
        "top_margin_mm": "Blank space at the top of each A4 page.",
        "bottom_margin_mm": "Blank space at the bottom of each A4 page. The footer is drawn inside this area.",
        "side_margin_mm": "Left and right page margin.",
        "column_gap_mm": "Space between fields across the slip.",
        "padding_mm": "Inner text padding inside each field area.",
        "cut_tick_mm": "Length of small cut marks at the page edges.",
        "column_width_evenness": "How evenly fields share width. 1 is equal widths, 0 follows each row's text lengths.",
        "column_min_width_ratio": "Smallest share of slip width any field should receive.",
        "column_max_width_ratio": "Largest share of slip width any field should receive.",
        "header_color": "Header colour as a hex value.",
        "header_font_pt": "Maximum header text size.",
        "data_font_pt": "Maximum data text size.",
        "minimum_font_pt": "Smallest text size allowed when fitting long text.",
        "show_footer": "Show a small footer in the bottom page margin without changing slip positions.",
        "show_sheet_name": "Show the Excel sheet name in the footer.",
        "show_generated_datetime": "Show the generated date and time in the footer.",
        "show_page_numbers": "Show page numbers as Page X of Y in the footer.",
        "footer_font_pt": "Footer text size.",
        "footer_color": "Footer text colour as a hex value.",
    }


def layout_field_names() -> tuple[str, ...]:
    return (
        "header_height_mm",
        "data_height_mm",
        "top_margin_mm",
        "bottom_margin_mm",
        "side_margin_mm",
        "column_gap_mm",
        "padding_mm",
        "cut_tick_mm",
        "column_width_evenness",
        "column_min_width_ratio",
        "column_max_width_ratio",
        "header_color",
        "header_font_pt",
        "data_font_pt",
        "minimum_font_pt",
        "show_footer",
        "show_sheet_name",
        "show_generated_datetime",
        "show_page_numbers",
        "footer_font_pt",
        "footer_color",
    )


def workbook_sheet_names(path: str) -> list[str]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        return workbook.sheetnames
    finally:
        workbook.close()


def workbook_headers(path: str, sheet_name: str) -> list[str]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        row = next(workbook[sheet_name].iter_rows(min_row=1, max_row=1, values_only=True), ())
        return unique_labels(row)
    finally:
        workbook.close()


def workbook_records(path: str, sheet_name: str, columns: list[str]) -> list[list[str]]:
    if not columns:
        return []

    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = workbook[sheet_name]
        headers = unique_labels(next(sheet.iter_rows(min_row=1, max_row=1, values_only=True), ()))
        indexes = [headers.index(column) for column in columns]
        records = []
        for row in sheet.iter_rows(min_row=2, values_only=True):
            values = ["" if index >= len(row) or row[index] is None else str(row[index]) for index in indexes]
            if any(value.strip() for value in values):
                records.append(values)
        return records
    finally:
        workbook.close()


def unique_labels(values) -> list[str]:
    labels = []
    counts: dict[str, int] = {}
    for index, value in enumerate(values, start=1):
        label = str(value).strip() if value is not None else f"Column {index}"
        counts[label] = counts.get(label, 0) + 1
        labels.append(label if counts[label] == 1 else f"{label} ({counts[label]})")
    return labels


def slips_per_page(settings: Settings) -> int:
    usable_height = 297 - settings.top_margin_mm - settings.bottom_margin_mm
    if settings.slip_height_mm <= 0 or usable_height <= 0:
        return 0
    return int(usable_height // settings.slip_height_mm)


def page_count(settings: Settings, slip_count: int) -> int:
    per_page = slips_per_page(settings)
    return math.ceil(slip_count / per_page) if per_page else 0


def column_widths(columns: list[str], record: list[str], settings: Settings, available_width: float) -> list[float]:
    if not columns:
        return []

    if len(columns) == 1:
        return [available_width]

    even_width = available_width / len(columns)
    evenness = clamp(settings.column_width_evenness, 0, 1)
    scores = []
    for index, column in enumerate(columns):
        value = record[index] if index < len(record) else ""
        header_score = stringWidth(column, "Helvetica-Bold", settings.header_font_pt)
        value_score = stringWidth(value, "Helvetica", settings.data_font_pt)
        scores.append(max(1, header_score, value_score))

    total = sum(scores)
    text_widths = [available_width * score / total for score in scores]
    widths = [even_width * evenness + text_width * (1 - evenness) for text_width in text_widths]

    minimum = min(even_width, available_width * clamp(settings.column_min_width_ratio, 0, 1))
    maximum = max(minimum, available_width * clamp(settings.column_max_width_ratio, 0, 1))
    return fit_widths(widths, minimum, maximum, available_width)


def fit_widths(widths: list[float], minimum: float, maximum: float, total_width: float) -> list[float]:
    widths = [min(max(width, minimum), maximum) for width in widths]
    difference = total_width - sum(widths)

    for _ in range(len(widths) * 2):
        if abs(difference) < 0.01:
            break
        if difference > 0:
            adjustable = [index for index, width in enumerate(widths) if width < maximum]
        else:
            adjustable = [index for index, width in enumerate(widths) if width > minimum]
        if not adjustable:
            break
        change = difference / len(adjustable)
        for index in adjustable:
            widths[index] = min(max(widths[index] + change, minimum), maximum)
        difference = total_width - sum(widths)

    if widths:
        widths[-1] += total_width - sum(widths)
    return widths


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, float(value)))


def shrink_to_fit(text: str, font: str, maximum: float, minimum: float, width: float, height: float) -> float:
    size = min(maximum, height / 1.15)
    measured = stringWidth(text, font, size)
    if not text or measured <= width:
        return size
    return max(minimum, min(size, width / max(1, stringWidth(text, font, 1))))


def short_text(text: str, font: str, size: float, width: float) -> str:
    if stringWidth(text, font, size) <= width:
        return text
    suffix = "..."
    if stringWidth(suffix, font, size) > width:
        return ""
    while text and stringWidth(text + suffix, font, size) > width:
        text = text[:-1]
    return text + suffix


def draw_pdf_text(pdf: canvas.Canvas, text: str, font: str, maximum: float, minimum: float,
                  x: float, y: float, width: float, height: float, color) -> None:
    size = shrink_to_fit(text, font, maximum, minimum, width, height)
    pdf.setFillColor(color)
    pdf.setFont(font, size)
    pdf.drawCentredString(x + width / 2, y + (height - size) / 2 + size * 0.18, short_text(text, font, size, width))


def output_path(settings: Settings) -> Path:
    workbook = Path(settings.workbook)
    name = workbook.stem if workbook.name else "password slips"
    return Path(settings.output_folder or downloads_folder()).expanduser() / f"{name} - password slips.pdf"


def make_pdf(settings: Settings) -> tuple[int, int]:
    records = workbook_records(settings.workbook, settings.sheet, settings.columns)
    if not records:
        raise ValueError("No slips to generate.")

    per_page = slips_per_page(settings)
    if per_page < 1:
        raise ValueError("The slip height and margins do not fit on A4.")

    page_width, page_height = A4
    top = settings.top_margin_mm * MM
    side = settings.side_margin_mm * MM
    header_height = settings.header_height_mm * MM
    data_height = settings.data_height_mm * MM
    slip_height = settings.slip_height_mm * MM
    gap = settings.column_gap_mm * MM
    padding = settings.padding_mm * MM
    content_width = page_width - side * 2
    column_area = content_width - gap * (len(settings.columns) - 1)

    output = output_path(settings)
    output.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    pdf.setTitle(APP_NAME)

    pages = page_count(settings, len(records))
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    for page in range(pages):
        draw_cut_ticks(pdf, settings, page_width, page_height, per_page)
        draw_footer(pdf, settings, page + 1, pages, generated_at, page_width)
        page_records = records[page * per_page:(page + 1) * per_page]
        for slot, record in enumerate(page_records):
            widths = column_widths(settings.columns, record, settings, column_area)
            draw_slip(pdf, settings, record, widths, side, page_height - top - slot * slip_height, content_width)
        pdf.showPage()

    pdf.save()
    if not output.is_file():
        raise ValueError(f"Could not create PDF at {output}")
    return len(records), pages


def open_print_dialog(pdf: Path) -> bool:
    if not pdf.is_file():
        return False

    script = '''
on run argv
    tell application "Preview"
        activate
        open POSIX file (item 1 of argv)
        delay 0.5
        print front document with print dialog
    end tell
end run
'''
    try:
        subprocess.run(["osascript", "-e", script, str(pdf)], check=True)
        return True
    except Exception:
        subprocess.run(["open", str(pdf)], check=False)
        return False


def draw_cut_ticks(pdf: canvas.Canvas, settings: Settings, page_width: float, page_height: float, per_page: int) -> None:
    top = settings.top_margin_mm * MM
    slip_height = settings.slip_height_mm * MM
    tick = settings.cut_tick_mm * MM
    pdf.setStrokeColor(HexColor("#777777"))
    pdf.setLineWidth(0.35)
    for boundary in range(per_page + 1):
        y = page_height - top - boundary * slip_height
        pdf.line(0, y, tick, y)
        pdf.line(page_width - tick, y, page_width, y)


def draw_footer(pdf: canvas.Canvas, settings: Settings, page_number: int, page_total: int,
                generated_at: str, page_width: float) -> None:
    if not settings.show_footer:
        return

    parts = []
    if settings.show_sheet_name and settings.sheet:
        parts.append(f"Sheet: {settings.sheet}")
    if settings.show_generated_datetime:
        parts.append(f"Generated: {generated_at}")
    if settings.show_page_numbers:
        parts.append(f"Page {page_number} of {page_total}")
    if not parts:
        return

    side = settings.side_margin_mm * MM
    y = max(3 * MM, settings.bottom_margin_mm * MM / 2)
    text = "  |  ".join(parts)
    available_width = page_width - side * 2
    size = shrink_to_fit(text, "Helvetica", settings.footer_font_pt, settings.minimum_font_pt,
                         available_width, settings.footer_font_pt * 1.5)
    pdf.setFillColor(HexColor(settings.footer_color))
    pdf.setFont("Helvetica", size)
    pdf.drawCentredString(page_width / 2, y, short_text(text, "Helvetica", size, available_width))


def draw_slip(pdf: canvas.Canvas, settings: Settings, record: list[str], widths: list[float],
              left: float, top: float, content_width: float) -> None:
    header_height = settings.header_height_mm * MM
    data_height = settings.data_height_mm * MM
    gap = settings.column_gap_mm * MM
    padding = settings.padding_mm * MM
    header_y = top - header_height
    data_y = header_y - data_height

    pdf.setFillColor(HexColor(settings.header_color))
    pdf.rect(left, header_y, content_width, header_height, stroke=0, fill=1)

    x = left
    for index, width in enumerate(widths):
        text_width = max(1, width - padding * 2)
        draw_pdf_text(pdf, settings.columns[index], "Helvetica-Bold", settings.header_font_pt,
                      settings.minimum_font_pt, x + padding, header_y, text_width, header_height, HexColor("#FFFFFF"))
        draw_pdf_text(pdf, record[index], "Helvetica", settings.data_font_pt, settings.minimum_font_pt,
                      x + padding, data_y, text_width, data_height, HexColor("#000000"))
        x += width + gap


def prompt(label: str, default: str = "") -> str:
    shown = f" [{default}]" if default else ""
    value = input(f"{label}{shown}: ").strip()
    return value or default


def banner() -> None:
    print()
    print(APP_NAME)
    print(f"Created by {AUTHOR}, {YEAR} | {LICENSE_NAME} licensed")
    print("Cut-aligned A4 password slip PDFs from Excel.")
    print("Press Enter to accept a suggestion.")


def section(title: str) -> None:
    print()
    print(title)
    print("-" * len(title))


def clean_path(value: str) -> str:
    try:
        parts = shlex.split(value)
        return parts[0] if len(parts) == 1 else value
    except ValueError:
        return value.strip("'\"")


def choose_workbook(settings: Settings) -> str:
    section("Workbook")
    latest = newest_workbook(settings.input_folder, settings.workbook_extensions)
    if latest:
        print(f"Latest Excel file in {settings.input_folder}: {latest}")
    else:
        print(f"No Excel files found in {settings.input_folder}.")

    while True:
        default = str(latest) if latest else ""
        label = "Excel file path (Enter = latest file)" if latest else "Excel file path"
        path = Path(clean_path(prompt(label, default))).expanduser()
        if path.is_file() and path.suffix.lower() in set(settings.workbook_extensions):
            settings.input_folder = str(path.parent)
            return str(path)
        allowed = ", ".join(settings.workbook_extensions)
        print(f"That Excel file is not available. Enter a path ending in {allowed}.")


def choose_from_list(title: str, choices: list[str], default: str = "") -> str:
    if not choices:
        raise ValueError(f"No {title.lower()} found.")
    section(title)
    for index, choice in enumerate(choices, start=1):
        marker = " *" if choice == default else ""
        print(f"  {index}. {choice}{marker}")

    default_index = str(choices.index(default) + 1) if default in choices else "1"
    while True:
        value = prompt(f"Choose {title.lower()} number", default_index)
        if value.isdigit() and 1 <= int(value) <= len(choices):
            return choices[int(value) - 1]
        if value in choices:
            return value
        print("Enter a number from the list.")


def choose_columns(headers: list[str], settings: Settings) -> tuple[list[str], list[int]]:
    if not headers:
        raise ValueError("No column headings were found in the first row.")

    default_numbers = remembered_column_numbers(headers, settings)

    section("Columns")
    for index, header in enumerate(headers, start=1):
        marker = " *" if index in default_numbers else ""
        print(f"  {index}. {header}{marker}")
    print("Enter numbers in the order to print them, for example 1,3,4.")

    while True:
        value = prompt("Column numbers", ",".join(str(number) for number in default_numbers))
        if value.strip().lower() == "all":
            numbers = list(range(1, len(headers) + 1))
            return list(headers), numbers

        numbers = column_numbers_from_text(value, headers)
        if numbers:
            return [headers[number - 1] for number in numbers], numbers

        print("Enter at least one valid column number.")


def remembered_column_numbers(headers: list[str], settings: Settings) -> list[int]:
    numbers = [
        number for number in settings.column_numbers
        if isinstance(number, int) and 1 <= number <= len(headers)
    ]
    if numbers:
        return numbers

    return list(range(1, len(headers) + 1))


def column_numbers_from_text(value: str, headers: list[str]) -> list[int]:
    tokens = value.replace(",", " ").split()
    numbers = []
    for token in tokens:
        if not token.isdigit():
            return []
        number = int(token)
        if not 1 <= number <= len(headers):
            return []
        if number not in numbers:
            numbers.append(number)
    return numbers


def choose_output_folder(default: str) -> str:
    section("Output")
    while True:
        folder = Path(clean_path(prompt("Output folder", default or str(downloads_folder())))).expanduser()
        if folder.exists() and not folder.is_dir():
            print("Output folder must be a folder, not a file.")
            continue
        return str(folder)


def choose_action(default: str) -> str:
    section("Finish")
    action = prompt("Action: export or print", default).strip().lower()
    if action in {"p", "print"}:
        return "print"
    return "export"


def preview_records(columns: list[str], records: list[list[str]]) -> None:
    section("Preview")
    if not records:
        print("  No data rows found with those columns.")
        return

    for row_number, row in enumerate(records[:3], start=1):
        print(f"  Slip {row_number}:")
        for column, value in zip(columns, row):
            shown = value if len(value) <= 70 else value[:67] + "..."
            print(f"    {column}: {shown}")
    if len(records) > 3:
        print(f"  ...and {len(records) - 3} more")


def print_summary(settings: Settings, slip_count: int) -> None:
    per_page = slips_per_page(settings)
    pages = page_count(settings, slip_count)
    print()
    print(f"Ready: {slip_count} slips, {pages} {plural(pages, 'page')}, {per_page} slips per page.")


def plural(count: int, singular: str) -> str:
    return singular if count == 1 else singular + "s"


def run_cli() -> None:
    banner()

    settings = read_saved_settings()

    while True:
        settings.workbook = choose_workbook(settings)
        try:
            sheets = workbook_sheet_names(settings.workbook)
            break
        except Exception as error:
            print(f"Could not open that workbook: {error}")
            settings.workbook = ""

    settings.sheet = choose_from_list("Sheets", sheets, settings.sheet)

    headers = workbook_headers(settings.workbook, settings.sheet)
    settings.columns, settings.column_numbers = choose_columns(headers, settings)
    settings.output_folder = choose_output_folder(settings.output_folder)

    records = workbook_records(settings.workbook, settings.sheet, settings.columns)
    preview_records(settings.columns, records)
    print_summary(settings, len(records))

    action = choose_action(settings.default_action)
    settings.default_action = action

    if not Path(settings.workbook).is_file():
        raise ValueError("Choose an Excel workbook.")
    if not settings.columns:
        raise ValueError("Choose at least one column.")

    count, pages = make_pdf(settings)
    save_settings(settings)
    pdf = output_path(settings)
    print()
    print("Done")
    print(f"  Created {count} slips across {pages} {plural(pages, 'page')}.")
    print(f"  PDF: {pdf}")

    if action in {"print", "p"}:
        if open_print_dialog(pdf):
            print("Opened the macOS print dialog.")
        else:
            print("Opened the PDF. Use File > Print if the print dialog did not appear.")


def main() -> None:
    try:
        run_cli()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
    except Exception as error:
        print(f"\nError: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
