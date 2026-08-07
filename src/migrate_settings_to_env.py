#!/usr/bin/env python3
"""Merge legacy JSON settings into .env without removing existing env fields."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Optional


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SETTINGS_FILE = ROOT_DIR / "settings" / "settings.json"
DEFAULT_LAYOUT_FILE = ROOT_DIR / "settings" / "layout_settings.json"
DEFAULT_ENV_FILE = ROOT_DIR / ".env"

LAYOUT_KEYS = (
    "header_height_mm",
    "data_height_mm",
    "slip_padding_mm",
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
    "data_font",
    "password_font",
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

ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def column_number(value: Any) -> Optional[int]:
    text = str(value).strip().upper()
    if text.isdigit():
        number = int(text)
        return number if number > 0 else None
    if not text.isalpha():
        return None

    number = 0
    for letter in text:
        number = number * 26 + ord(letter) - 64
    return number if number > 0 else None


def column_letter(number: int) -> str:
    letters = ""
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def column_letters(value: Any) -> list[str]:
    letters = []
    for item in value if isinstance(value, list) else []:
        number = column_number(item)
        if number:
            letter = column_letter(number)
            if letter not in letters:
                letters.append(letter)
    return letters


def migrated_row_filters(value: Any) -> list[dict[str, Any]]:
    migrated = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        rule = dict(item)
        value_for_column = rule.get("column_letter", rule.get("column_number"))
        number = column_number(value_for_column)
        if number is None:
            continue
        rule.pop("column_number", None)
        rule["column_letter"] = column_letter(number)
        migrated.append(rule)
    return migrated


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError) as error:
        raise ValueError(f"Could not read {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Expected an object in {path}.")
    return value


def value_from(data: dict[str, Any], key: str, legacy_key: Optional[str] = None) -> tuple[bool, Any]:
    if key in data:
        return True, data[key]
    if legacy_key and legacy_key in data:
        return True, data[legacy_key]
    return False, None


def settings_updates(settings: dict[str, Any], layout: dict[str, Any]) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    direct_fields = {
        "input_folder": "PASSWORD_SLIPS_INPUT_FOLDER",
        "output_folder": "PASSWORD_SLIPS_OUTPUT_FOLDER",
        "workbook_extensions": "PASSWORD_SLIPS_WORKBOOK_EXTENSIONS",
        "blank_slips": "PASSWORD_SLIPS_BLANK_SLIPS",
        "email_pdf": "PASSWORD_SLIPS_EMAIL_PDF",
    }
    for old_key, env_key in direct_fields.items():
        if old_key in settings:
            updates[env_key] = settings[old_key]

    column_fields = (
        ("column_letters", "column_numbers", "PASSWORD_SLIPS_COLUMN_LETTERS"),
        ("password_column_letters", "password_column_numbers", "PASSWORD_SLIPS_PASSWORD_COLUMN_LETTERS"),
        ("truncate_column_letters", "truncate_column_numbers", "PASSWORD_SLIPS_TRUNCATE_COLUMN_LETTERS"),
    )
    for new_key, legacy_key, env_key in column_fields:
        found, value = value_from(settings, new_key, legacy_key)
        if found:
            updates[env_key] = column_letters(value)

    rule_fields = (
        ("row_filters", "PASSWORD_SLIPS_ROW_FILTERS"),
        ("selected_row_filters", "PASSWORD_SLIPS_SELECTED_ROW_FILTERS"),
    )
    for old_key, env_key in rule_fields:
        if old_key in settings:
            updates[env_key] = migrated_row_filters(settings[old_key])

    found, value = value_from(settings, "include_summary_page", "summary_page")
    if found:
        updates["PASSWORD_SLIPS_INCLUDE_SUMMARY_PAGE"] = value

    if "email_address" in settings:
        updates["PASSWORD_SLIPS_EMAIL_ADDRESS"] = settings["email_address"]

    for key in LAYOUT_KEYS:
        if key in layout:
            updates[f"PASSWORD_SLIPS_{key.upper()}"] = layout[key]
    return updates


def env_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return json.dumps(value, separators=(",", ":"))
    if value is None:
        return ""
    text = str(value)
    return json.dumps(text) if any(character.isspace() for character in text) or text.startswith("#") else text


def existing_env_keys(lines: list[str]) -> dict[str, list[int]]:
    positions: dict[str, list[int]] = {}
    for index, line in enumerate(lines):
        match = ENV_ASSIGNMENT.match(line)
        if match:
            positions.setdefault(match.group(1), []).append(index)
    return positions


def merge_env(path: Path, updates: dict[str, Any], dry_run: bool = False) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True) if path.is_file() else []
    except OSError as error:
        raise ValueError(f"Could not read {path}: {error}") from error

    positions = existing_env_keys(lines)
    changed_keys = []
    additions = []
    for key, value in updates.items():
        replacement = f"{key}={env_value(value)}\n"
        if key in positions:
            for index in positions[key]:
                lines[index] = replacement
        else:
            additions.append(replacement)
        changed_keys.append(key)

    if additions:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        if lines and lines[-1].strip():
            lines.append("\n")
        lines.append("# Migrated from legacy JSON settings\n")
        lines.extend(additions)

    if not dry_run and (changed_keys or additions):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(lines), encoding="utf-8")
    return changed_keys


def migrate_settings_to_env(settings_path: Path, layout_path: Path, env_path: Path,
                            dry_run: bool = False) -> list[str]:
    updates = settings_updates(read_json(settings_path), read_json(layout_path))
    return merge_env(env_path, updates, dry_run=dry_run)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge legacy settings/settings.json and layout_settings.json into .env."
    )
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS_FILE)
    parser.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT_FILE)
    parser.add_argument("--env", dest="env_path", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--dry-run", action="store_true", help="Show what would be migrated without writing.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    keys = migrate_settings_to_env(args.settings, args.layout, args.env_path, args.dry_run)
    action = "Would migrate" if args.dry_run else "Migrated"
    print(f"{action} {len(keys)} settings into {args.env_path}.")
    print("Existing env fields, including fields absent from the legacy JSON, were preserved.")


if __name__ == "__main__":
    main()
