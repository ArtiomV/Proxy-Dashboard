'use strict';

// One source of truth for choosing credentials used by automated checks.
// ProxySmart may return technical randomport* entries, expired assignments and
// over-quota ports alongside a working client port; never probe through those.
function flagIsTrue(value) {
  if (value === true || value === 1) return true;
  return /^(?:1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

function isAutoPortName(value) {
  return /^randomport(?:\d+)?$/i.test(String(value || '').trim());
}

function isValidClientHttpPort(port, nowMs = Date.now()) {
  if (!port || !String(port.HTTP_PORT || '').trim()) return false;
  const portNumber = Number(port.HTTP_PORT);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return false;
  if (!String(port.LOGIN || '').trim() || !String(port.PASSWORD || '').trim()) return false;

  const client = String(port.portName || '').trim();
  if (!client || isAutoPortName(client)) return false;
  if (flagIsTrue(port.IS_EXPIRED) || flagIsTrue(port.IS_OVER_QUOTA)) return false;

  if (port.PROXY_VALID_BEFORE) {
    const validBefore = Date.parse(port.PROXY_VALID_BEFORE);
    if (!Number.isNaN(validBefore) && validBefore < nowMs) return false;
  }
  return true;
}

function pickValidClientHttpPort(ports, nowMs = Date.now()) {
  return (Array.isArray(ports) ? ports : []).find((port) => isValidClientHttpPort(port, nowMs)) || null;
}

module.exports = { flagIsTrue, isAutoPortName, isValidClientHttpPort, pickValidClientHttpPort };
