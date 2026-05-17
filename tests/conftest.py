"""Shared pytest fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

# Make ``sync`` package importable (it lives outside ``src/``).
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
