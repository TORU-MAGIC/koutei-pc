# -*- coding: utf-8 -*-
"""
工程表 2日前倒しツール  ―  本体(ハイブリッド版)
================================================
HTML/CSS/JavaScript のモダンUIを、Python標準ライブラリだけの軽量ローカルサーバで配信し、
Microsoft Edge / Google Chrome の「アプリモード」(タブ・アドレスバーの無い独立ウィンドウ)で開く。
実際のExcel編集は koutei_shift.py(openpyxl)のエンジンが行う。

  画面(JS) ──HTTP/JSON──> ローカルサーバ(Python) ──> koutei_shift エンジン(openpyxl)

特徴: 追加インストール不要・完全オフライン・127.0.0.1 のみ・ウィンドウを閉じると自動終了。
起動: 「工程表2日前倒しツール.bat」をダブルクリック (= python koutei_app.py)。
"""

import os
import sys
import json
import time
import shutil
import threading
import traceback
import subprocess
import webbrowser
import urllib.parse
import http.server
import socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import koutei_shift as engine   # エンジン(openpyxl)

INDEX = os.path.join(HERE, "index.html")
PICK_SCRIPT = os.path.join(HERE, "pick_file_dialog.py")
ERROR_LOG = os.path.join(HERE, "_error.log")

IDLE_SHUTDOWN_SEC = 180         # この秒数 ハートビートが途絶えたら自動終了(=ウィンドウが閉じた)
NO_WINDOW = 0x08000000          # subprocess: CREATE_NO_WINDOW (Windows)


# ----------------------------------------------------------------------------
# ブラウザ(アプリモード)の起動
# ----------------------------------------------------------------------------
def find_browser():
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pfx = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    la = os.environ.get("LOCALAPPDATA", "")
    cands = [
        os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pfx, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pfx, "Google", "Chrome", "Application", "chrome.exe"),
    ]
    if la:
        cands.append(os.path.join(la, "Google", "Chrome", "Application", "chrome.exe"))
    for c in cands:
        if os.path.isfile(c):
            return c
    for name in ("msedge", "chrome"):
        w = shutil.which(name)
        if w:
            return w
    return None


def open_app_window(url):
    """Edge/Chrome のアプリモードで独立ウィンドウを開く。無ければ既定ブラウザ。"""
    exe = find_browser()
    if exe:
        try:
            subprocess.Popen([exe, "--app=%s" % url, "--window-size=940,960"])
            return "app"
        except Exception:
            pass
    try:
        webbrowser.open(url)
        return "browser"
    except Exception:
        return "none"


# ----------------------------------------------------------------------------
# ネイティブのファイル選択ダイアログ(別プロセス)
# ----------------------------------------------------------------------------
def native_pick(initialdir=""):
    try:
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        kw = {}
        if os.name == "nt":
            kw["creationflags"] = NO_WINDOW
        r = subprocess.run([sys.executable, PICK_SCRIPT, initialdir or ""],
                           capture_output=True, env=env, timeout=300, **kw)
        return (r.stdout or b"").decode("utf-8", "replace").strip()
    except Exception:
        return ""


def open_in_explorer(path):
    try:
        if os.path.isfile(path):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            os.startfile(os.path.dirname(path) or ".")
        return True
    except Exception:
        try:
            os.startfile(os.path.dirname(path) or ".")
            return True
        except Exception:
            return False


# ----------------------------------------------------------------------------
# サーバ本体
# ----------------------------------------------------------------------------
def run(port=8799, open_window=True):
    class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True
        last_beat = time.time()

    class Handler(http.server.BaseHTTPRequestHandler):
        # ---- 低レベル送信 ----
        def _send(self, code, body=b"", ctype="application/octet-stream", extra=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if extra:
                for k, v in extra.items():
                    self.send_header(k, v)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False),
                       "application/json; charset=utf-8")

        def _body_json(self):
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n) if n else b""
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))

        def _touch(self):
            self.server.last_beat = time.time()

        def log_message(self, *a):
            pass

        # ---- GET ----
        def do_GET(self):
            self._touch()
            path = urllib.parse.urlparse(self.path).path
            if path in ("/", "/index.html"):
                try:
                    with open(INDEX, "rb") as f:
                        self._send(200, f.read(), "text/html; charset=utf-8")
                except FileNotFoundError:
                    self._send(404, "index.html が見つかりません", "text/plain; charset=utf-8")
            elif path == "/health":
                self._send(200, "ok", "text/plain")
            elif path == "/favicon.ico":
                self._send(204)
            else:
                self._send(404, "not found", "text/plain")

        # ---- POST ----
        def do_POST(self):
            self._touch()
            path = urllib.parse.urlparse(self.path).path
            try:
                if path == "/ping":
                    return self._json({"ok": True})
                if path in ("/bye", "/shutdown"):
                    self._json({"ok": True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
                if path == "/pick":
                    body = self._body_json()
                    p = native_pick(body.get("initialdir", ""))
                    return self._json({"path": p})
                if path == "/open-folder":
                    body = self._body_json()
                    ok = open_in_explorer(body.get("path", ""))
                    return self._json({"ok": ok})
                if path == "/process":
                    return self._handle_process()
                self._json({"error": "unknown endpoint"}, 404)
            except Exception as e:
                self._json({"error": str(e)}, 400)

        def _handle_process(self):
            body = self._body_json()
            in_path = (body.get("path") or "").strip().strip('"')
            spillover = body.get("spillover", "prepend")
            rewrite = bool(body.get("rewrite", False))
            output = body.get("output", "newfile")  # newfile / overwrite

            if not in_path:
                return self._json({"error": "ファイルが選択されていません。"}, 400)
            if not os.path.isfile(in_path):
                return self._json({"error": "ファイルが見つかりません:\n%s" % in_path}, 400)
            if not in_path.lower().endswith((".xlsx", ".xlsm")):
                return self._json({"error": "Excel(.xlsx)ファイルを選んでください。"}, 400)
            try:
                s = engine.process(in_path, spillover=spillover,
                                   rewrite_dates=rewrite, output_mode=output,
                                   log=lambda m: None)
                s["ok"] = True
                return self._json(s)
            except PermissionError:
                return self._json({"error": "出力ファイルを保存できません。\n"
                                   "出力先のExcelを閉じてから、もう一度実行してください。"}, 400)
            except Exception as e:
                return self._json({"error": "処理中にエラー: %s" % e}, 400)

    # --- ポートを確保して起動 ---
    httpd = None
    for p in [port, port + 1, port + 2, 8780, 8781, 0]:
        try:
            httpd = Srv(("127.0.0.1", p), Handler)
            port = httpd.server_address[1]
            break
        except OSError:
            continue
    if httpd is None:
        raise RuntimeError("ローカルサーバを起動できませんでした。")

    url = "http://127.0.0.1:%d/" % port

    # --- ハートビート監視: ウィンドウが閉じて ping が途絶えたら自動終了 ---
    def watchdog():
        while True:
            time.sleep(10)
            if time.time() - httpd.last_beat > IDLE_SHUTDOWN_SEC:
                httpd.shutdown()
                break
    threading.Thread(target=watchdog, daemon=True).start()

    # --- 画面を開く ---
    bar = "=" * 56
    print(bar)
    print("  工程表 2日前倒しツール  ―  起動しました")
    print("  画面: %s" % url)
    print("  ウィンドウを閉じると自動的に終了します")
    print(bar)
    httpd.last_beat = time.time()
    if open_window:
        open_app_window(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    print("終了しました。")


def main():
    open_window = "--no-window" not in sys.argv
    port = 8799
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except Exception:
            pass
    try:
        run(port=port, open_window=open_window)
    except Exception:
        try:
            with open(ERROR_LOG, "w", encoding="utf-8") as f:
                f.write(traceback.format_exc())
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
