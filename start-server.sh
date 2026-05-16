HOST="127.0.0.1"
PORT="3000"
DISABLE_WEBXDC="0"
DISABLE_WASM="0"

POSITIONAL_INDEX=0
for ARG in "$@"; do
  case "$ARG" in
    --no-webxdc)
      DISABLE_WEBXDC="1"
      ;;
    --no-wasm)
      DISABLE_WASM="1"
      ;;
    *)
      if [ "$POSITIONAL_INDEX" -eq 0 ]; then
        HOST="$ARG"
      elif [ "$POSITIONAL_INDEX" -eq 1 ]; then
        PORT="$ARG"
      fi
      POSITIONAL_INDEX=$((POSITIONAL_INDEX + 1))
      ;;
  esac
done

[ "$HOST" = "-" ] && HOST="127.0.0.1"
[ "$PORT" = "-" ] && PORT="3000"

node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');

const host = process.argv[1];
const port = parseInt(process.argv[2], 10);
const disableWebxdc = process.argv[3] === '1';
const disableWasm = process.argv[4] === '1';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.toml': 'text/plain',
};

const server = http.createServer((req, res) => {
  const requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (disableWebxdc && requestPath === '/webxdc.js') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  let filePath = '.' + requestPath;
  filePath = path.normalize(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (disableWasm && ext === '.wasm') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
  console.log('Serving on http://' + host + ':' + port);
  if (disableWebxdc) {
    console.log('Returning 404 for /webxdc.js');
  }
  if (disableWasm) {
    console.log('Returning 404 for *.wasm');
  }
});
" "$HOST" "$PORT" "$DISABLE_WEBXDC" "$DISABLE_WASM"
