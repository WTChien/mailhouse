import unittest

from verification import extract_verification_code


class ExtractVerificationCodeTests(unittest.TestCase):
    def test_prefers_keyword_nearby_code(self) -> None:
        result = extract_verification_code(
            "Order 88442217 confirmation",
            "Your verification code is 731905. Do not share it.",
        )
        self.assertEqual(result, "731905")

    def test_supports_chinese_keyword(self) -> None:
        self.assertEqual(extract_verification_code("您的驗證碼：4821", ""), "4821")

    def test_supports_otp_in_body(self) -> None:
        self.assertEqual(extract_verification_code("Sign in", "OTP 908172 expires soon"), "908172")

    def test_rejects_year_without_code_context(self) -> None:
        self.assertIsNone(extract_verification_code("Your 2026 statement", "Account summary"))

    def test_rejects_compact_date(self) -> None:
        self.assertIsNone(extract_verification_code("Report date", "20261003"))

    def test_rejects_order_number_without_code(self) -> None:
        self.assertIsNone(extract_verification_code("Order confirmation", "Order number 12345678"))

    def test_accepts_uncontextualized_six_digit_value(self) -> None:
        self.assertEqual(extract_verification_code("Sign in", "731905"), "731905")

    def test_rejects_part_of_long_number(self) -> None:
        self.assertIsNone(extract_verification_code("Receipt", "Reference 123456789012"))


if __name__ == "__main__":
    unittest.main()
