"""Tests for sync/parser.py — pure functions, no I/O."""

from __future__ import annotations

from sync import parser


class TestCleanHtml:
    def test_empty_returns_empty(self) -> None:
        assert parser.clean_html("") == ""
        assert parser.clean_html("   ") == ""

    def test_strips_tags(self) -> None:
        out = parser.clean_html("<p>hello <b>world</b></p>")
        assert "<" not in out
        assert ">" not in out
        assert "hello" in out
        assert "world" in out

    def test_preserves_paragraph_breaks(self) -> None:
        html = "<p>line one</p><p>line two</p>"
        out = parser.clean_html(html)
        assert "line one" in out
        assert "line two" in out
        assert "\n" in out

    def test_drops_script_and_style(self) -> None:
        html = "<p>visible</p><script>alert('x')</script><style>body{}</style>"
        out = parser.clean_html(html)
        assert "visible" in out
        assert "alert" not in out
        assert "body" not in out

    def test_collapses_whitespace(self) -> None:
        out = parser.clean_html("<p>foo     bar\t\tbaz</p>")
        assert "foo bar baz" in out

    def test_lists_become_lines(self) -> None:
        html = "<ul><li>a</li><li>b</li><li>c</li></ul>"
        out = parser.clean_html(html)
        for letter in "abc":
            assert letter in out


class TestBuildBodyText:
    def test_concatenates_title_and_body(self) -> None:
        result = parser.build_body_text("Title", "Body content")
        assert result.startswith("Title")
        assert "Body content" in result

    def test_title_only(self) -> None:
        assert parser.build_body_text("Title", "") == "Title"

    def test_body_only(self) -> None:
        assert parser.build_body_text("", "Body") == "Body"

    def test_both_empty(self) -> None:
        assert parser.build_body_text("", "") == ""

    def test_strips_whitespace(self) -> None:
        result = parser.build_body_text("  Title  ", "  Body  ")
        assert result == "Title\n\nBody"


class TestComputeHash:
    def test_is_64_hex_chars(self) -> None:
        h = parser.compute_hash("hello")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_deterministic(self) -> None:
        assert parser.compute_hash("hello") == parser.compute_hash("hello")

    def test_changes_when_content_changes(self) -> None:
        assert parser.compute_hash("hello") != parser.compute_hash("world")

    def test_known_sha256(self) -> None:
        # SHA256("") known value
        assert (
            parser.compute_hash("")
            == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
