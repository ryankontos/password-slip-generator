import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from src.password_slips import (
    Settings,
    automatic_blank_slips,
    choose_action,
    choose_columns,
    configured_email_address,
    generated_records,
    make_pdf,
    open_email_draft,
    row_numbers_from_text,
    summary_page_count,
)


class PasswordSlipGenerationTests(unittest.TestCase):
    def test_automatic_blanks_finish_a_partial_page(self):
        self.assertEqual(automatic_blank_slips(0, 10), 0)
        self.assertEqual(automatic_blank_slips(10, 10), 0)
        self.assertEqual(automatic_blank_slips(12, 10), 8)
        self.assertEqual(automatic_blank_slips(19, 10), 1)

    def test_generated_records_put_extra_blanks_after_automatic_blanks(self):
        settings = Settings(columns=["Name", "Password"], blank_slips=2)
        data_records = [["user001", "pass001"], ["user002", "pass002"]]

        records = generated_records(settings, data_records)

        self.assertEqual(len(records), 9)
        self.assertEqual(records[:2], data_records)
        self.assertTrue(all(not any(row) for row in records[2:]))

    def test_summary_is_counted_after_slip_pages(self):
        settings = Settings(columns=["Name"], include_summary_page=True)
        data_records = [["user001"], ["user002"]]

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "password-slips.pdf"
            slip_count, page_count = make_pdf(settings, output, data_records)

        self.assertEqual(slip_count, 7)
        self.assertEqual(page_count, 2)
        self.assertEqual(summary_page_count(settings, len(data_records)), 1)

    def test_manual_row_ranges_remain_supported(self):
        self.assertEqual(row_numbers_from_text("2, 5, 9-11"), [2, 5, 9, 10, 11])

    def test_column_names_can_be_reselected_after_preview(self):
        settings = Settings()

        with patch("builtins.input", side_effect=["B,A", "n", "A", "y"]):
            columns, numbers, password_numbers, truncate_numbers = choose_columns(
                ["First name", "Password"],
                settings,
            )

        self.assertEqual(columns, ["First name"])
        self.assertEqual(numbers, [1])
        self.assertEqual(password_numbers, [])
        self.assertEqual(truncate_numbers, [])

    def test_email_delivery_choice_is_remembered(self):
        settings = Settings(email_address="staff@example.com")

        with patch("builtins.input", return_value="2"):
            action = choose_action(settings)

        self.assertEqual(action, "email")
        self.assertTrue(settings.email_pdf)

        with patch("builtins.input", return_value="1"):
            action = choose_action(settings)

        self.assertEqual(action, "export")
        self.assertFalse(settings.email_pdf)

    def test_email_choice_requires_an_env_address(self):
        settings = Settings()

        with patch("builtins.input", return_value="2"):
            action = choose_action(settings)

        self.assertEqual(action, "export")
        self.assertFalse(settings.email_pdf)

    def test_email_address_comes_from_environment(self):
        with patch.dict("os.environ", {"PASSWORD_SLIPS_EMAIL_ADDRESS": "staff@example.com"}, clear=True):
            self.assertEqual(configured_email_address(), "staff@example.com")

    def test_email_draft_uses_pdf_name_as_subject(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            pdf = Path(temporary_directory) / "staff slips.pdf"
            pdf.write_bytes(b"%PDF-test")
            completed = unittest.mock.Mock(stdout="outlook\n")

            with patch("src.password_slips.subprocess.run", return_value=completed) as run:
                opened, attached = open_email_draft(pdf, "staff@example.com")

        self.assertEqual((opened, attached), (True, True))
        command = run.call_args.args[0]
        self.assertEqual(command[0], "osascript")
        self.assertIn("Microsoft Outlook", command[2])
        self.assertIn("subjectLine", command[2])
        self.assertEqual(command[5], "staff slips.pdf")


if __name__ == "__main__":
    unittest.main()
