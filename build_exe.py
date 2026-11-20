#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 StructBoard 打包成可双击运行的本机程序（PyInstaller --onedir）。

用法（在 structboard/ 目录下）：
    python build_exe.py

产物： dist/StructBoard/StructBoard.exe  +  同目录下的静态资源与 pipelines/
双击 StructBoard.exe 即起本地服务并自动开浏览器，行为同 `python serve.py`。

为什么用 --onedir 而非 --onefile：
    应用会往 pipelines/ 写用户导入的管线、往数据目录写 .pipeline_notes.json。
    --onefile 每次把文件解压到临时目录，用户创建的管线重启就消失；
    --onedir 让数据落在 exe 旁，能持久化。
"""
import importlib.util
import os
from pathlib import Path

SRC = os.path.dirname(os.path.abspath(__file__))
_contract_spec = importlib.util.spec_from_file_location("structboard_resource_contract", Path(SRC) / "resource_contract.py")
resources = importlib.util.module_from_spec(_contract_spec)
_contract_spec.loader.exec_module(resources)


def collect_datas():
    return resources.web_datas(SRC)


def main():
    from PyInstaller.__main__ import run

    resources.validate_frontend_build(SRC)
    resources.capture_source(SRC)
    datas = collect_datas()
    opts = [
        os.path.join(SRC, 'serve.py'),
        '--name', 'StructBoard',
        '--onedir',
        '--clean',
        '--noconfirm',
        '--paths', SRC,
        '--icon', os.path.join(SRC, 'app_icon.ico'),
        '--hidden-import', 'pipeline_api',
        '--hidden-import', 'scaffold_pipeline',
        '--log-level', 'INFO',
    ]
    for s, d in datas:
        opts += ['--add-data', '%s%s%s' % (s, os.pathsep, d)]

    print('打包静态资源数: %d' % len(datas))
    for s, d in datas:
        print('  +', d, '/', os.path.basename(s))
    print('')
    run(opts)
    print('')
    print('完成：dist/StructBoard/StructBoard.exe')


if __name__ == '__main__':
    main()
