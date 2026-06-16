#!/usr/bin/env python3
"""Generate cut-aligned password slip PDFs from the newest Excel file in Downloads."""

from __future__ import annotations

import json
import math
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from openpyxl import load_workbook
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


APP_NAME = "password-slip-generator"
SCRIPT_DIR = Path(__file__).resolve().parent
LAYOUT_FILE = SCRIPT_DIR / "layout_settings.json"
STATE_FILE = SCRIPT_DIR / "last_run.json"
MM = 72 / 25.4


@dataclass
class Settings:
    workbook: str = ""
    sheet: str = ""
    columns: list[str] = field(default_factory=list)
    column_numbers: list[int] = field(default_factory=list)
    output_folder: str = ""

    header_height_mm: float = 20.0
    data_height_mm: float = 20.0
    top_margin_mm: float = 8.0
    bottom_margin_mm: float = 8.0
    side_margin_mm: float = 5.0
    column_gap_mm: float = 2.0
    padding_mm: float = 2.0
    cut_tick_mm: float = 4.0

    header_color: str = "#1769AA"
    header_font_pt: float = 11.0
    data_font_pt: float = 12.0
    minimum_font_pt: float = 4.0

    @property
    def slip_height_mm(self) -> float:
        return self.header_height_mm + self.data_height_mm


def downloads_folder() -> Path:
    return Path.home() / "Downloads"


def newest_downloaded_workbook() -> Optional[Path]:
    folder = downloads_folder()
    if not folder.is_dir():
        return None

    files = [
        file for file in folder.iterdir()
        if file.is_file()
        and file.suffix.lower() in {".xlsx", ".xlsm"}
        and not file.name.startswith((".", "~$"))
    ]
    return max(files, key=lambda file: file.stat().st_mtime) if files else None


def read_saved_settings() -> Settings:
    settings = Settings()
    ensure_json_files(settings)
    apply_saved_layout(settings)
    apply_saved_state(settings)
    settings.output_folder = str(downloads_folder())
    return settings


def ensure_json_files(defaults: Settings) -> None:
    if not LAYOUT_FILE.exists():
        save_layout_file(defaults)
    if not STATE_FILE.exists():
        save_state_file([])


def apply_saved_layout(settings: Settings) -> None:
    try:
        data = migrate_layout_settings(json.loads(LAYOUT_FILE.read_text(encoding="utf-8")))
        for key, value in data.items():
            setattr(settings, key, value)
        HexColor(settings.header_color)
    except (OSError, TypeError, ValueError):
        print(f"Could not read {LAYOUT_FILE.name}; using built-in layout defaults.")


def apply_saved_state(settings: Settings) -> None:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        numbers = data.get("column_numbers", [])
        settings.column_numbers = [int(number) for number in numbers]
    except (OSError, TypeError, ValueError):
        settings.column_numbers = []


def migrate_layout_settings(data: dict) -> dict:
    renamed = dict(data)
    if "horizontal_padding_mm" in renamed and "padding_mm" not in renamed:
        renamed["padding_mm"] = renamed.pop("horizontal_padding_mm")
    if "header_font_max_pt" in renamed and "header_font_pt" not in renamed:
        renamed["header_font_pt"] = renamed.pop("header_font_max_pt")
    if "data_font_max_pt" in renamed and "data_font_pt" not in renamed:
        renamed["data_font_pt"] = renamed.pop("data_font_max_pt")
    if "font_min_pt" in renamed and "minimum_font_pt" not in renamed:
        renamed["minimum_font_pt"] = renamed.pop("font_min_pt")

    valid_names = set(layout_field_names())
    return {key: value for key, value in renamed.items() if key in valid_names}


def save_settings(settings: Settings) -> None:
    save_state_file(settings.column_numbers)


def save_state_file(column_numbers: list[int]) -> None:
    STATE_FILE.write_text(json.dumps({"column_numbers": column_numbers}, indent=2), encoding="utf-8")


def save_layout_file(settings: Settings) -> None:
    layout = {}
    for name in layout_field_names():
        layout[name] = getattr(settings, name)
    LAYOUT_FILE.write_text(json.dumps(layout, indent=2), encoding="utf-8")


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
        "header_color",
        "header_font_pt",
        "data_font_pt",
        "minimum_font_pt",
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


def column_widths(columns: list[str], records: list[list[str]], available_width: float) -> list[float]:
    if not columns:
        return []

    scores = []
    for index, column in enumerate(columns):
        lengths = [len(column)] + [len(row[index]) for row in records if index < len(row)]
        likely = sorted(lengths)[max(0, math.ceil(len(lengths) * 0.85) - 1)]
        scores.append(max(5, min(32, likely + 1.5)))

    minimum = min(available_width * 0.055, available_width / len(columns) * 0.72)
    leftover = max(0, available_width - minimum * len(columns))
    total = sum(scores)
    return [minimum + leftover * score / total for score in scores]


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
    widths = column_widths(settings.columns, records, column_area)

    output = output_path(settings)
    output.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    pdf.setTitle(APP_NAME)

    pages = page_count(settings, len(records))
    for page in range(pages):
        draw_cut_ticks(pdf, settings, page_width, page_height, per_page)
        page_records = records[page * per_page:(page + 1) * per_page]
        for slot, record in enumerate(page_records):
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


def clean_path(value: str) -> str:
    try:
        parts = shlex.split(value)
        return parts[0] if len(parts) == 1 else value
    except ValueError:
        return value.strip("'\"")


def choose_workbook(saved_path: str = "") -> str:
    latest = newest_downloaded_workbook()
    if latest:
        print(f"Latest Excel file in Downloads: {latest}")
    elif saved_path:
        print(f"Last workbook: {saved_path}")

    while True:
        default = str(latest) if latest else saved_path
        label = "Excel file path (Enter = latest Downloads file)" if latest else "Excel file path"
        path = Path(clean_path(prompt(label, default))).expanduser()
        if path.is_file() and path.suffix.lower() in {".xlsx", ".xlsm"}:
            return str(path)
        print("That Excel file is not available. Enter the path to an .xlsx or .xlsm file.")


def choose_from_list(title: str, choices: list[str], default: str = "") -> str:
    if not choices:
        raise ValueError(f"No {title.lower()} found.")
    print(f"\n{title}:")
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
        print("Choose a number from the list.")


def choose_columns(headers: list[str], settings: Settings) -> tuple[list[str], list[int]]:
    if not headers:
        raise ValueError("No column headings were found in the first row.")

    default_numbers = remembered_column_numbers(headers, settings)

    print("\nColumns:")
    for index, header in enumerate(headers, start=1):
        marker = " *" if index in default_numbers else ""
        print(f"  {index}. {header}{marker}")
    print("Enter column numbers in the order they should appear. Example: 1,3,4")

    while True:
        value = prompt("Column numbers", ",".join(str(number) for number in default_numbers))
        if value.strip().lower() == "all":
            numbers = list(range(1, len(headers) + 1))
            return list(headers), numbers

        numbers = column_numbers_from_text(value, headers)
        if numbers:
            return [headers[number - 1] for number in numbers], numbers

        print("Choose at least one valid column number.")


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
    while True:
        folder = Path(clean_path(prompt("Output folder", default or str(downloads_folder())))).expanduser()
        if folder.exists() and not folder.is_dir():
            print("Output folder must be a folder, not a file.")
            continue
        return str(folder)


def preview_records(columns: list[str], records: list[list[str]]) -> None:
    print("\nPreview:")
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
    print(f"\n{slip_count} slips | {pages} {plural(pages, 'page')} | {per_page} slips per page")
    print(f"Output: {output_path(settings)}")


def plural(count: int, singular: str) -> str:
    return singular if count == 1 else singular + "s"


def run_cli() -> None:
    print(f"\n{APP_NAME}")
    print("Press Enter to use the suggested answer.\n")

    settings = read_saved_settings()

    while True:
        settings.workbook = choose_workbook(settings.workbook)
        try:
            sheets = workbook_sheet_names(settings.workbook)
            break
        except Exception as error:
            print(f"Could not open that workbook: {error}")
            settings.workbook = ""

    settings.sheet = choose_from_list("Sheets", sheets, settings.sheet)

    headers = workbook_headers(settings.workbook, settings.sheet)
    settings.columns, settings.column_numbers = choose_columns(headers, settings)
    settings.output_folder = choose_output_folder(str(downloads_folder()))

    records = workbook_records(settings.workbook, settings.sheet, settings.columns)
    preview_records(settings.columns, records)
    print_summary(settings, len(records))
    print(f"Layout settings: {LAYOUT_FILE}")

    action = prompt("Action: export or print", "export").strip().lower()
    if action not in {"export", "e", "print", "p"}:
        action = "export"

    if not Path(settings.workbook).is_file():
        raise ValueError("Choose an Excel workbook.")
    if not settings.columns:
        raise ValueError("Choose at least one column.")

    count, pages = make_pdf(settings)
    save_settings(settings)
    pdf = output_path(settings)
    print(f"\nCreated {count} slips across {pages} {plural(pages, 'page')}.")
    print(pdf)

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
