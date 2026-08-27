'use strict';

// Один проводной speedtest на физическую площадку. Серверы с одинаковым
// адресом объединяются, поэтому несколько ProxySmart-боксов на одной линии
// не расходуют трафик повторно. Источник — SSH технического пользователя;
// сначала используем Ookla/speedtest-cli, при их отсутствии — контролируемый
// Cloudflare-тест (25 МБ download + 5 МБ upload).

const childProcess = require('child_process');
const { buildCostLocations } = require('../billing/cost-locations');

const SSH_PORTS = [2222, 22];
const SSH_TIMEOUT_MS = 150000;
const RETENTION_DAYS = 90;

// Порядок методов: Ookla → Cloudflare → speedtest-cli (только если нет curl).
// speedtest-cli (старый python-клиент) на части боксов возвращает МУСОР с exit 0
// (инцидент 27.08: RO1/S1 — download 0.0, ping 1800000 мс, сервер в Турции),
// поэтому он больше не может перебивать рабочий Cloudflare-тест.
// Результат с download ИЛИ upload = 0 отбраковывается в parseWanSpeedOutput.
const WAN_SPEED_CMD = [
  'if command -v speedtest >/dev/null 2>&1; then',
  "  out=$(speedtest --accept-license --accept-gdpr --format=json 2>/dev/null) && { printf '%s\\n%s' '__METHOD_OOKLA__' \"$out\"; exit 0; };",
  'fi;',
  'if command -v curl >/dev/null 2>&1; then',
  "  down=$(curl -L -o /dev/null -sS --max-time 60 -w '%{speed_download}|%{time_connect}|%{remote_ip}' 'https://speed.cloudflare.com/__down?bytes=50000000') || exit 41;",
  "  up=$(dd if=/dev/zero bs=1M count=10 2>/dev/null | curl -o /dev/null -sS --max-time 60 -w '%{speed_upload}' -X POST --data-binary @- 'https://speed.cloudflare.com/__up') || exit 42;",
  "  printf '%s\\n%s\\n%s' '__METHOD_CLOUDFLARE__' \"$down\" \"$up\"; exit 0;",
  'fi;',
  'if command -v speedtest-cli >/dev/null 2>&1; then',
  "  out=$(speedtest-cli --json 2>/dev/null) && { printf '%s\\n%s' '__METHOD_SPEEDTEST_CLI__' \"$out\"; exit 0; };",
  'fi;',
  "printf '%s' '__NO_SPEEDTEST_TOOL__'; exit 43",
].join(' ');

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function extractJson(text) {
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('speedtest вернул ответ без JSON');
  return JSON.parse(String(text).slice(start, end + 1));
}

function parseWanSpeedOutput(stdout) {
  const text = String(stdout || '').trim();
  if (text.startsWith('__METHOD_OOKLA__')) {
    const j = extractJson(text);
    const download = j.download && Number(j.download.bandwidth);
    const upload = j.upload && Number(j.upload.bandwidth);
    if (!(download > 0 && upload > 0)) throw new Error('Ookla вернул нулевую скорость');
    return {
      method: 'ookla',
      download_mbps: round(download * 8 / 1e6),
      upload_mbps: round(upload * 8 / 1e6),
      ping_ms: round(j.ping && j.ping.latency),
      jitter_ms: round(j.ping && j.ping.jitter),
      packet_loss_pct: round(j.packetLoss),
      provider: String(j.isp || ''),
      external_ip: String((j.interface && j.interface.externalIp) || ''),
    };
  }
  if (text.startsWith('__METHOD_SPEEDTEST_CLI__')) {
    const j = extractJson(text);
    if (!(Number(j.download) > 0 && Number(j.upload) > 0)) throw new Error('speedtest-cli вернул нулевую скорость');
    return {
      method: 'speedtest-cli',
      download_mbps: round(Number(j.download) / 1e6),
      upload_mbps: round(Number(j.upload) / 1e6),
      ping_ms: round(j.ping),
      jitter_ms: null,
      packet_loss_pct: null,
      provider: String((j.client && j.client.isp) || ''),
      external_ip: String((j.client && j.client.ip) || ''),
    };
  }
  if (text.startsWith('__METHOD_CLOUDFLARE__')) {
    const lines = text.split(/\r?\n/);
    const down = String(lines[1] || '').split('|');
    const downloadBps = Number(down[0]);
    const uploadBps = Number(lines[2]);
    if (!(downloadBps > 0 || uploadBps > 0)) throw new Error('Cloudflare не вернул скорость');
    return {
      method: 'cloudflare',
      download_mbps: round(downloadBps * 8 / 1e6),
      upload_mbps: round(uploadBps * 8 / 1e6),
      ping_ms: round(Number(down[1]) * 1000),
      jitter_ms: null,
      packet_loss_pct: null,
      provider: '',
      external_ip: String(down[2] || ''),
    };
  }
  if (text.includes('__NO_SPEEDTEST_TOOL__')) throw new Error('на сервере нет speedtest и curl');
  throw new Error('неизвестный ответ WAN speedtest');
}

function create(deps) {
  const { db, logger, apiServers } = deps;
  const execFile = deps.execFile || childProcess.execFile;
  const insert = db.prepare(`INSERT INTO location_wan_speed
    (location_key,location_label,server_name,collected_at,download_mbps,upload_mbps,
     ping_ms,jitter_ms,packet_loss_pct,provider,external_ip,method,ok,error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  function sshPorts(server) {
    const result = [];
    const custom = Number(server.sshPort);
    if (custom > 0 && custom < 65536) result.push(custom);
    for (const port of SSH_PORTS) if (!result.includes(port)) result.push(port);
    return result;
  }

  function sshOnce(server, port, useKey) {
    return new Promise((resolve, reject) => {
      const args = ['-o', `BatchMode=${useKey ? 'yes' : 'no'}`, '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8',
        '-o', 'IdentitiesOnly=yes',
        ...(useKey ? [] : ['-o', 'PreferredAuthentications=password,keyboard-interactive']),
        '-p', String(port),
        `${server.osLogin}@${server.publicIp}`, WAN_SPEED_CMD];
      const bin = useKey ? 'ssh' : 'sshpass';
      const argv = useKey ? args : ['-p', server.osPassword, 'ssh', ...args];
      execFile(bin, argv, { timeout: SSH_TIMEOUT_MS, maxBuffer: 512 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  }

  async function measureServer(server) {
    if (!server.osLogin || !server.publicIp) throw new Error('не настроен технический SSH-доступ');
    let lastError = null, keyError = null;
    for (const port of sshPorts(server)) {
      try { return parseWanSpeedOutput(await sshOnce(server, port, true)); }
      catch (error) { if (!keyError) keyError = error; lastError = error; }
    }
    if (server.osPassword) {
      for (const port of sshPorts(server)) {
        try { return parseWanSpeedOutput(await sshOnce(server, port, false)); }
        catch (error) { lastError = error; }
      }
    }
    // Если sshpass-фолбэк тоже упал, его ошибка («Auth failed») маскирует
    // настоящую причину — показываем ошибку ключевой попытки тоже.
    if (keyError && lastError && keyError.message !== lastError.message) {
      throw new Error(`${keyError.message.slice(0, 140)} | fallback: ${lastError.message.slice(0, 100)}`);
    }
    throw lastError || new Error('SSH недоступен');
  }

  let running = false;
  async function runLocationWanSpeed() {
    if (running) return { skipped: 'already_running' };
    running = true;
    let ok = 0, failed = 0;
    try {
      const locations = buildCostLocations(apiServers);
      for (const location of locations) {
        const candidates = location.servers
          .map(item => apiServers.find(server => server.name === item.name))
          .filter(Boolean);
        let result = null, source = null, lastError = null;
        for (const server of candidates) {
          try {
            result = await measureServer(server);
            source = server;
            break;
          } catch (error) {
            lastError = error;
            logger.info(`[LocationWAN] ${location.label} via ${server.name}: ${error.message}`);
          }
        }
        const now = new Date().toISOString();
        if (result && source) {
          insert.run(location.key, location.label, source.name, now,
            result.download_mbps, result.upload_mbps, result.ping_ms, result.jitter_ms,
            result.packet_loss_pct, result.provider, result.external_ip, result.method, 1, '');
          ok++;
          logger.info(`[LocationWAN] ${location.label}: ↓${result.download_mbps} ↑${result.upload_mbps} Мбит/с (${result.method}, ${source.name})`);
        } else {
          const message = String((lastError && lastError.message) || 'нет доступного сервера').slice(0, 240);
          insert.run(location.key, location.label, '', now,
            null, null, null, null, null, '', '', '', 0, message);
          failed++;
        }
      }
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400e3).toISOString();
      const pruned = db.prepare('DELETE FROM location_wan_speed WHERE collected_at < ?').run(cutoff).changes;
      return { ok, failed, pruned };
    } finally {
      running = false;
    }
  }

  return { runLocationWanSpeed, measureServer };
}

module.exports = { create, parseWanSpeedOutput, WAN_SPEED_CMD, SSH_PORTS };
