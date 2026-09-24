#!/usr/bin/env python3
"""
自動テスト用の簡易サーバー。プロジェクトルートを配信し、すべての応答に
Cache-Control: no-store を付ける（python -m http.server は既定でキャッシュを許可してしまい、
ソースを編集しても古い .js がブラウザにキャッシュされたまま実行され続けることがあるため）。

使い方:
    cd C:\\work\\chrome_ex\\auto_bookmark
    python tests/serve.py [ポート番号（省略時 8765）]
    → http://localhost:8765/tests/run.html を開く
"""
import http.server
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PROJECT_ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # 静かに


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
