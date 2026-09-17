import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const http = require('http');
const { fetchThroughProxy } = require('../src/jobs/http-check');

async function withProxy(handler, test) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await test({ host: '127.0.0.1', port: server.address().port }, server); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

describe('HTTP check transport', () => {
  it('decodes chunked content across chunk boundaries', async () => {
    await withProxy((_req, res) => {
      res.write('Example ');
      setImmediate(() => res.end('Domain'));
    }, async proxy => {
      expect(await fetchThroughProxy(proxy, 'http://example.com', 1000))
        .toMatchObject({ status: 200, body: 'Example Domain' });
    });
  });
  it('settles oversized bodies with an exact bounded prefix', async () => {
    await withProxy((_req, res) => res.end('x'.repeat(600 * 1024)), async proxy => {
      const result = await fetchThroughProxy(proxy, 'http://example.com', 1000);
      expect(result.body.length).toBe(512 * 1024);
    });
  });
  it('rejects a truncated response instead of reporting success on close', async () => {
    await withProxy((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('short');
      setImmediate(() => res.destroy());
    }, async proxy => {
      await expect(fetchThroughProxy(proxy, 'http://example.com', 1000)).rejects.toThrow();
    });
  });
  it('enforces a total deadline even when data keeps arriving', async () => {
    await withProxy((_req, res) => {
      const interval = setInterval(() => res.write('x'), 10);
      res.on('close', () => clearInterval(interval));
    }, async proxy => {
      await expect(fetchThroughProxy(proxy, 'http://example.com', 80)).rejects.toThrow('timeout');
    });
  });
  it('uses the configured HTTPS port and preserves CONNECT errors', async () => {
    await withProxy((_req, res) => res.end(), async (proxy, server) => {
      let authority;
      server.on('connect', (req, socket) => {
        authority = req.url;
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      });
      await expect(fetchThroughProxy(proxy, 'https://example.com:8443', 1000))
        .rejects.toThrow('CONNECT status 407');
      expect(authority).toBe('example.com:8443');
    });
  });
  it('parses chunked and large bodies through a real TLS tunnel', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tls = require('tls');
    const net = require('net');
    const https = require('https');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'httpcheck-tls-'));
    let upstream, spy;
    const sockets = new Set();
    try {
      require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey',
        'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out',
        path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
      const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
      upstream = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, (req, res) => {
        if (req.url === '/large') return res.end('x'.repeat(600 * 1024));
        res.write('Example ');
        setImmediate(() => res.end('Domain'));
      });
      upstream.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const connect = tls.connect;
      // Trust only this test's ephemeral CA; certificate verification stays enabled.
      spy = vi.spyOn(tls, 'connect').mockImplementation((options, callback) =>
        connect({ ...options, ca: cert }, callback));
      await withProxy((_req, res) => res.end(), async (proxy, server) => {
        server.on('connect', (_req, socket) => {
          const remote = net.connect(upstream.address().port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            socket.pipe(remote).pipe(socket);
          });
          remote.on('error', () => socket.destroy());
          socket.on('close', () => remote.destroy());
        });
        const url = 'https://localhost:' + upstream.address().port;
        expect(await fetchThroughProxy(proxy, url, 2000))
          .toMatchObject({ status: 200, body: 'Example Domain' });
        expect((await fetchThroughProxy(proxy, url + '/large', 2000)).body.length)
          .toBe(512 * 1024);
        expect(spy.mock.calls.every(([options]) => options.rejectUnauthorized === true)).toBe(true);
      });
    } finally {
      spy?.mockRestore();
      for (const socket of sockets) socket.destroy();
      if (upstream) await new Promise(resolve => upstream.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
