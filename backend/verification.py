import re
from dataclasses import dataclass
from typing import Optional


KEYWORD_PATTERN = re.compile(
    r"\b(?:verification\s*code|one[-\s]*time\s*(?:password|passcode|code)|"
    r"security\s*code|auth(?:entication)?\s*code|verify|otp|passcode|code)\b|"
    r"驗證碼|認證碼|確認碼|一次性密碼",
    re.IGNORECASE,
)
NEGATIVE_CONTEXT_PATTERN = re.compile(
    r"\b(?:order|invoice|tracking|reference|receipt|account|customer|postal|zip)\b|"
    r"訂單|發票|追蹤|編號|郵遞區號|帳號",
    re.IGNORECASE,
)
NUMERIC_CODE_PATTERN = re.compile(r"(?<!\d)\d{4,8}(?!\d)")
TIME_CONTEXT_PATTERN = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
DATE_CONTEXT_PATTERN = re.compile(
    r"\b(?:19|20)\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b|"
    r"\b\d{1,2}[-/.月]\d{1,2}(?:日|[-/.](?:19|20)?\d{2})?\b"
)


@dataclass(frozen=True)
class CodeCandidate:
    value: str
    score: int
    position: int


def _candidate_score(source: str, value: str, start: int, subject_length: int) -> int:
    context_start = max(0, start - 80)
    context_end = min(len(source), start + len(value) + 80)
    context = source[context_start:context_end]
    local_start = start - context_start

    score = 0
    if start < subject_length:
        score += 35
    if len(value) == 6:
        score += 12
    elif len(value) in {5, 7}:
        score += 5

    keyword_distances: list[int] = []
    for match in KEYWORD_PATTERN.finditer(context):
        keyword_center = (match.start() + match.end()) // 2
        code_center = local_start + len(value) // 2
        keyword_distances.append(abs(code_center - keyword_center))

    if keyword_distances:
        distance = min(keyword_distances)
        # A keyword immediately adjacent to the number is much stronger than
        # one that merely appears elsewhere in the same subject/body window.
        score += max(20, 130 - (distance * 2))

    if NEGATIVE_CONTEXT_PATTERN.search(context):
        score -= 55

    if len(value) == 4 and 1900 <= int(value) <= 2099:
        score -= 90

    if len(value) == 8:
        try:
            year, month, day = int(value[:4]), int(value[4:6]), int(value[6:])
            if 1900 <= year <= 2099 and 1 <= month <= 12 and 1 <= day <= 31:
                score -= 100
        except ValueError:
            pass

    if TIME_CONTEXT_PATTERN.search(context) or DATE_CONTEXT_PATTERN.search(context):
        score -= 45

    return score


def extract_verification_code(subject: str = "", body: str = "") -> Optional[str]:
    """Return the most likely 4-8 digit verification code, or None."""
    clean_subject = str(subject or "").strip()
    clean_body = str(body or "").strip()
    source = f"{clean_subject}\n{clean_body}"
    subject_length = len(clean_subject)

    candidates: list[CodeCandidate] = []
    for match in NUMERIC_CODE_PATTERN.finditer(source):
        value = match.group(0)
        candidates.append(
            CodeCandidate(
                value=value,
                score=_candidate_score(source, value, match.start(), subject_length),
                position=match.start(),
            )
        )

    if not candidates:
        return None

    best = max(candidates, key=lambda item: (item.score, -item.position))
    # Uncontextualized 4-8 digit values are still accepted, except candidates
    # that strongly resemble dates, years, times, or business identifiers.
    return best.value if best.score >= 0 else None
