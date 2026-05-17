"""HTML → clean text + content hash. Pure functions, no I/O."""

from __future__ import annotations

import hashlib
import re

from bs4 import BeautifulSoup

_WS_RE = re.compile(r"[ \t]+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def clean_html(html: str) -> str:
    """Strip HTML, keep paragraph breaks, collapse runs of whitespace."""
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    # Drop tags whose content is noise for retrieval.
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    # Insert newlines after block-level tags so the structure survives extraction.
    for block in soup.find_all(
        ["p", "br", "li", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]
    ):
        block.append("\n")

    text = soup.get_text()
    text = _WS_RE.sub(" ", text)
    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(line for line in lines if line)
    text = _BLANK_LINES_RE.sub("\n\n", text)
    return text.strip()


def build_body_text(title: str, clean_text: str) -> str:
    title = (title or "").strip()
    body = clean_text.strip()
    if title and body:
        return f"{title}\n\n{body}"
    return title or body


def compute_hash(body_text: str) -> str:
    return hashlib.sha256(body_text.encode("utf-8")).hexdigest()
