# -*- coding: utf-8 -*-
"""OSのネイティブ『ファイルを開く』ダイアログを表示し、選ばれたパスを標準出力(UTF-8)へ返す。
koutei_app.py から別プロセスで呼び出される(tkinterをメインスレッドで安全に使うため)。
引数1: 初期フォルダ(省略可)。"""
import sys


def main():
    initial = sys.argv[1] if len(sys.argv) > 1 else ""
    path = ""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        path = filedialog.askopenfilename(
            title="工程表(.xlsx)を選択",
            initialdir=(initial or None),
            filetypes=[("Excel ブック", "*.xlsx;*.xlsm"), ("すべてのファイル", "*.*")],
        )
        try:
            root.destroy()
        except Exception:
            pass
    except Exception:
        path = ""
    # エンコーディング設定に依存せず UTF-8 バイトで返す
    try:
        sys.stdout.buffer.write((path or "").encode("utf-8"))
        sys.stdout.buffer.flush()
    except Exception:
        sys.stdout.write(path or "")


if __name__ == "__main__":
    main()
