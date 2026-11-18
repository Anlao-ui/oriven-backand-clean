import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixture_html():
    return lambda name: (FIX / name).read_text(encoding="utf-8")


@pytest.fixture
def conn(tmp_path):
    from growth_engine import db
    return db.connect(tmp_path / "test.db")


@pytest.fixture
def cfg():
    from growth_engine.config import load_config
    return load_config()
