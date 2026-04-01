'use strict';

const https = require('https');
const logger = require('../logger');

// Tochka API helper — HTTPS requests to enter.tochka.com
function tochkaRequest(tochkaConfig, method, apiPath, body) {
  if (typeof apiPath !== 'string' || apiPath.includes('..')) throw new Error('Invalid Tochka API path');
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Bearer ${tochkaConfig.jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (tochkaConfig.customerCode) headers['CustomerCode'] = tochkaConfig.customerCode;
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);
    const req = https.request({
      hostname: 'enter.tochka.com',
      port: 443,
      path: apiPath,
      method: method,
      headers,
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf.toString()), headers: res.headers }); }
          catch (e) { resolve({ status: res.statusCode, data: buf.toString(), headers: res.headers }); }
        } else if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
          resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
        } else {
          resolve({ status: res.statusCode, data: buf.toString(), headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tochka API timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = { tochkaRequest };
