# PyInstaller spec for TradingWiev.exe (one-file, console window = quit by closing it).
# Build with:  python desktop/build_exe.py   (prepares the frontend + icon, then runs this)
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

HERE = Path(SPECPATH).resolve()
ROOT = HERE.parent

datas = [
    (str(HERE / "build" / "static"), "app/static"),  # built frontend
    (str(ROOT / "data" / "news" / "forexfactory_news.csv"), "seed/news"),  # calendar history
]
archive = ROOT / "data" / "news" / "ff_feed_archive.json"
if archive.exists():
    datas.append((str(archive), "seed/news"))
datas += collect_data_files("tzdata")  # zoneinfo has no system tz database on Windows

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("app")
    + [
        "bridge",
        "MetaTrader5",
        "multipart",
        "python_multipart",
        "pyarrow",
        "pyarrow.parquet",
        "sqlalchemy.dialects.sqlite",
    ]
)

a = Analysis(
    [str(HERE / "launcher.py")],
    pathex=[str(ROOT / "backend"), str(ROOT / "mt5bridge")],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "PIL", "matplotlib", "IPython", "notebook", "tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="TradingWiev",
    icon=str(HERE / "icon.ico"),
    console=True,
    upx=False,
    version=str(HERE / "version_info.txt"),
)
