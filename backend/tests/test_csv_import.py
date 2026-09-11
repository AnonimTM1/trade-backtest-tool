from app.data.csv_import import parse_csv_bytes, CsvImportError


MT5_SAMPLE = (
    "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\r\n"
    "2024.01.02\t00:00:00\t2062.50\t2063.10\t2062.10\t2062.90\t120\t0\t20\r\n"
    "2024.01.02\t00:01:00\t2062.90\t2063.50\t2062.80\t2063.20\t95\t0\t18\r\n"
    "2024.01.02\t00:02:00\t2063.20\t2063.40\t2062.90\t2063.00\t80\t0\t19\r\n"
)

GENERIC_SAMPLE = (
    "time,open,high,low,close,volume,spread\n"
    "2024-01-02T00:00:00,2062.50,2063.10,2062.10,2062.90,120,20\n"
    "2024-01-02T00:01:00,2062.90,2063.50,2062.80,2063.20,95,18\n"
)

GENERIC_UNIX_SAMPLE = (
    "time,open,high,low,close\n"
    "1704153600,2062.50,2063.10,2062.10,2062.90\n"
    "1704153660,2062.90,2063.50,2062.80,2063.20\n"
)


def test_parse_mt5_format():
    result = parse_csv_bytes(MT5_SAMPLE.encode())
    assert result.detected_format == "mt5"
    assert len(result.rows) == 3
    assert result.rows[0]["open"] == 2062.50
    assert result.rows[0]["spread"] == 20
    assert not result.rejected


def test_parse_generic_iso_format():
    result = parse_csv_bytes(GENERIC_SAMPLE.encode())
    assert result.detected_format == "generic"
    assert len(result.rows) == 2
    assert result.rows[0]["volume"] == 120


def test_parse_generic_unix_seconds():
    result = parse_csv_bytes(GENERIC_UNIX_SAMPLE.encode())
    assert len(result.rows) == 2
    assert result.rows[0]["timestamp"].year == 2024


def test_sorted_output_even_if_input_unsorted():
    unsorted = (
        "time,open,high,low,close\n"
        "2024-01-02T00:02:00,1,1,1,1\n"
        "2024-01-02T00:00:00,1,1,1,1\n"
        "2024-01-02T00:01:00,1,1,1,1\n"
    )
    result = parse_csv_bytes(unsorted.encode())
    timestamps = [r["timestamp"] for r in result.rows]
    assert timestamps == sorted(timestamps)


def test_duplicate_timestamps_rejected():
    dup = (
        "time,open,high,low,close\n"
        "2024-01-02T00:00:00,1,1,1,1\n"
        "2024-01-02T00:00:00,2,2,2,2\n"
    )
    result = parse_csv_bytes(dup.encode())
    assert len(result.rows) == 1
    assert len(result.rejected) == 1
    assert "duplicate" in result.rejected[0]["reason"]


def test_invalid_high_rejected():
    bad = (
        "time,open,high,low,close\n"
        "2024-01-02T00:00:00,10,9,8,10\n"  # high < max(open,close)
    )
    result = parse_csv_bytes(bad.encode())
    assert len(result.rows) == 0
    assert len(result.rejected) == 1


def test_invalid_low_rejected():
    bad = (
        "time,open,high,low,close\n"
        "2024-01-02T00:00:00,10,12,11,10\n"  # low > min(open,close)
    )
    result = parse_csv_bytes(bad.encode())
    assert len(result.rows) == 0
    assert len(result.rejected) == 1


def test_malformed_row_rejected_with_reason():
    bad = (
        "time,open,high,low,close\n"
        "2024-01-02T00:00:00,notanumber,9,8,10\n"
        "2024-01-02T00:01:00,9,10,8,9\n"
    )
    result = parse_csv_bytes(bad.encode())
    assert len(result.rows) == 1
    assert len(result.rejected) == 1
    assert "row_number" in result.rejected[0]


def test_missing_required_column_raises():
    bad = "time,open,high,close\n2024-01-02T00:00:00,1,2,1\n"
    try:
        parse_csv_bytes(bad.encode())
        assert False, "expected CsvImportError"
    except CsvImportError:
        pass


def test_empty_file_raises():
    try:
        parse_csv_bytes(b"")
        assert False, "expected CsvImportError"
    except CsvImportError:
        pass
