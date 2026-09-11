import os
import sys
import tempfile
from pathlib import Path

import pytest

# Point DATA_DIR at a temp dir before importing app.config anywhere.
_tmp = tempfile.mkdtemp(prefix="tradingwiev_test_")
os.environ["DATA_DIR"] = _tmp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _clear_resample_cache():
    from app.data import resample

    resample.invalidate_cache()
    yield
    resample.invalidate_cache()
