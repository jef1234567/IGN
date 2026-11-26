# Audit des calculs de vue : la page et sa scène synthétique, port 8766.
import http.server, os
ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.join(ICI, '..', '..', 'vue3d')
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, p):
        p = p.split('?')[0]
        if p in ('/', '/index.html'): return RACINE + '/static/index.html'
        if p.startswith('/api/scene'): return os.path.join(ICI, 'scene.json')
        return RACINE + p
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', 8766), H).serve_forever()
