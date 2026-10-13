// Дочерний процесс для tests/http-client-guard.test.js: воспроизводит
// ERR_INTERNAL_ASSERTION в socketOnData (парсер сокета отвязан, а данные
// продолжают приходить) и проверяет, что страж гасит его без падения.
const http = require('http');
const net = require('net');
const guard = require(process.argv[2]);
guard.install();
const out = { handled: 0, info: '', survived: false, otherRequestOk: false, socketDestroyed: false };
process.on('uncaughtException', (err) => {
  if (guard.handleUncaught(err, (info) => { out.info = info; })) { out.handled++; return; }
  console.log(JSON.stringify({ fatal: String(err && err.stack) })); process.exit(2);
});
const srv = net.createServer((c) => {
  c.on('error', () => {});
  c.once('data', () => {
    c.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart');
    setTimeout(() => { if (!c.destroyed) c.write('more-data'); }, 50);
  });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const req = http.get({ host: '127.0.0.1', port, path: '/apix/test?secret=1', agent: false }, (res) => {
    res.on('data', () => {});
    res.on('error', () => {});
    const sock = req.socket;
    sock.parser = null;              // имитация освобождённого парсера
    setTimeout(() => {
      out.socketDestroyed = sock.destroyed;
      // процесс жив и другие запросы работают
      const ok = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', function () {
        http.get({ host: '127.0.0.1', port: this.address().port, agent: false }, (r2) => {
          r2.resume(); r2.on('end', () => {
            out.otherRequestOk = true; out.survived = true;
            console.log(JSON.stringify(out)); process.exit(0);
          });
        });
      });
    }, 200);
  });
  req.on('error', () => {});
});
