#!/usr/bin/env python3
"""Generate cut-aligned password slip PDFs from the newest Excel file in Downloads."""

from __future__ import annotations

import json
import math
import shlex
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from openpyxl import load_workbook
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


APP_NAME = "password-slip-generator"
SETTINGS_FILE = Path.home() / "Library" / "Application Support" / "Password Slips" / "settings.json"
MM = 72 / 25.4


@dataclass
class Settings:
    workbook: str = ""
    sheet: str = ""
    columns: list[str] = field(default_factory=list)
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
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        saved = data.get("last_run") or (data.get("recent_runs") or [None])[0]
        settings = Settings(**migrate_saved_settings(saved or {}))
    except (OSError, TypeError, ValueError):
        settings = Settings()

    settings.output_folder = settings.output_folder or str(downloads_folder())

    # Downloads always wins on launch. Column choices still persist by name.
    latest = newest_downloaded_workbook()
    if latest:
        settings.workbook = str(latest)

    return settings


def migrate_saved_settings(data: dict) -> dict:
    renamed = dict(data)
    if "output" in renamed and "output_folder" not in renamed:
        renamed["output_folder"] = str(Path(renamed["output"]).expanduser().parent)
    if "horizontal_padding_mm" in renamed and "padding_mm" not in renamed:
        renamed["padding_mm"] = renamed.pop("horizontal_padding_mm")
    if "header_font_max_pt" in renamed and "header_font_pt" not in renamed:
        renamed["header_font_pt"] = renamed.pop("header_font_max_pt")
    if "data_font_max_pt" in renamed and "data_font_pt" not in renamed:
        renamed["data_font_pt"] = renamed.pop("data_font_max_pt")
    if "font_min_pt" in renamed and "minimum_font_pt" not in renamed:
        renamed["minimum_font_pt"] = renamed.pop("font_min_pt")

    valid_names = set(Settings.__dataclass_fields__)
    return {key: value for key, value in renamed.items() if key in valid_names}


def save_settings(settings: Settings) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps({"last_run": asdict(settings)}, indent=2), encoding="utf-8")


def save_field_choices(settings: Settings, columns: list[str]) -> None:
    settings.columns = list(columns)
    save_settings(settings)


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
    return len(records), pages


def open_print_dialog(pdf: Path) -> bool:
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
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or default


def prompt_yes_no(label: str, default: bool = False) -> bool:
    shown = "Y/n" if default else "y/N"
    while True:
        value = input(f"{label} [{shown}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Please enter y or n.")


def clean_path(value: str) -> str:
    try:
        parts = shlex.split(value)
        return parts[0] if len(parts) == 1 else value
    except ValueError:
        return value.strip("'\"")


def choose_workbook(default: str) -> str:
    while True:
        path = Path(clean_path(prompt("Workbook", default))).expanduser()
        if path.is_file() and path.suffix.lower() in {".xlsx", ".xlsm"}:
            return str(path)
        print("Enter the path to an .xlsx or .xlsm workbook.")


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


def choose_columns(headers: list[str], saved_columns: list[str]) -> list[str]:
    default = [column for column in saved_columns if column in headers] or list(headers)
    default_numbers = ",".join(str(headers.index(column) + 1) for column in default)

    print("\nColumns:")
    for index, header in enumerate(headers, start=1):
        marker = " *" if header in default else ""
        print(f"  {index}. {header}{marker}")
    print("Enter numbers or names in the order they should appear, or 'all'.")

    while True:
        value = prompt("Columns", default_numbers)
        if value.strip().lower() == "all":
            return list(headers)

        selected = []
        for item in [part.strip() for part in value.split(",") if part.strip()]:
            column = column_from_token(item, headers)
            if column and column not in selected:
                selected.append(column)

        if selected:
            return selected
        print("Choose at least one column.")


def column_from_token(token: str, headers: list[str]) -> Optional[str]:
    if token.isdigit() and 1 <= int(token) <= len(headers):
        return headers[int(token) - 1]

    lowered = token.lower()
    for header in headers:
        if header.lower() == lowered:
            return header
    return None


def choose_output_folder(default: str) -> str:
    while True:
        folder = Path(clean_path(prompt("Output folder", default or str(downloads_folder())))).expanduser()
        if folder.exists() and not folder.is_dir():
            print("Output folder must be a folder, not a file.")
            continue
        return str(folder)


def prompt_float(label: str, current: float) -> float:
    while True:
        value = prompt(label, format_number(current))
        try:
            number = float(value)
            if number > 0:
                return number
        except ValueError:
            pass
        print("Enter a positive number.")


def format_number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def edit_layout(settings: Settings) -> Settings:
    if not prompt_yes_no("\nChange layout settings?", False):
        return settings

    edited = Settings(**asdict(settings))
    fields = [
        ("Header height mm", "header_height_mm"),
        ("Data height mm", "data_height_mm"),
        ("Top margin mm", "top_margin_mm"),
        ("Bottom margin mm", "bottom_margin_mm"),
        ("Side margin mm", "side_margin_mm"),
        ("Column gap mm", "column_gap_mm"),
        ("Text padding mm", "padding_mm"),
        ("Cut tick length mm", "cut_tick_mm"),
        ("Header font pt", "header_font_pt"),
        ("Data font pt", "data_font_pt"),
        ("Minimum font pt", "minimum_font_pt"),
    ]
    for label, name in fields:
        setattr(edited, name, prompt_float(label, getattr(edited, name)))

    while True:
        color = prompt("Header colour", edited.header_color).strip()
        try:
            HexColor(color)
            edited.header_color = color
            break
        except ValueError:
            print("Enter a hex colour like #1769AA.")

    if slips_per_page(edited) < 1:
        print("Those layout settings do not fit on A4, keeping previous layout.")
        return settings
    return edited


def print_summary(settings: Settings, slip_count: int) -> None:
    per_page = slips_per_page(settings)
    pages = page_count(settings, slip_count)
    print(f"\n{slip_count} slips | {pages} pages | {per_page} slips per page")
    print(f"Output: {output_path(settings)}")


def run_cli() -> None:
    print(f"\n{APP_NAME}")
    print("Press Enter to keep the value in brackets.\n")

    settings = read_saved_settings()
    settings.workbook = choose_workbook(settings.workbook)

    sheets = workbook_sheet_names(settings.workbook)
    settings.sheet = choose_from_list("Sheets", sheets, settings.sheet)

    headers = workbook_headers(settings.workbook, settings.sheet)
    settings.columns = choose_columns(headers, settings.columns)
    settings.output_folder = choose_output_folder(settings.output_folder or str(downloads_folder()))

    records = workbook_records(settings.workbook, settings.sheet, settings.columns)
    print_summary(settings, len(records))

    settings = edit_layout(settings)
    print_summary(settings, len(records))

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
    print(f"\nCreated {count} slips across {pages} page(s).")
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
