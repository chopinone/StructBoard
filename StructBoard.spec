# -*- mode: python ; coding: utf-8 -*-
import importlib.util
from pathlib import Path

# Resolve from the spec location, including when invoked from another directory.
SRC = Path(SPECPATH).resolve()
_contract_spec = importlib.util.spec_from_file_location("structboard_resource_contract", SRC / "resource_contract.py")
resources = importlib.util.module_from_spec(_contract_spec)
_contract_spec.loader.exec_module(resources)
resources.capture_source(SRC)

a = Analysis(
    [str(SRC / 'serve.py')],
    pathex=[str(SRC)],
    binaries=[],
    datas=resources.web_datas(SRC),
    hiddenimports=['pipeline_api', 'scaffold_pipeline'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='StructBoard',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[str(SRC / 'app_icon.ico')],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='StructBoard',
)
