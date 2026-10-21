'use strict';
/*
 * Shared HTTP/HTTPS agents.
 *
 * Node's global agent already keeps connections alive, but it is shared with
 * everything else in the process and has no socket budget. A dedicated agent
 * lets downloadX reuse sockets between range requests (which is the common
 * case: one file is fetched in many small ranges) and keeps the number of
 * open sockets bounded.
 */
const http = require('http');
const https = require('https');

const MAX_SOCKETS = 64;
const MAX_FREE_SOCKETS = 16;
const KEEP_ALIVE_MS = 15000;
const SOCKET_TIMEOUT_MS = 30000;

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  keepAliveMsecs: KEEP_ALIVE_MS,
  timeout: SOCKET_TIMEOUT_MS,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  keepAliveMsecs: KEEP_ALIVE_MS,
  timeout: SOCKET_TIMEOUT_MS,
});

/**
 * The agent that fits the given URL protocol.
 * @param {string} protocol for example "https:"
 * @returns {import('http').Agent|import('https').Agent}
 */
function agentFor(protocol) {
  return protocol === 'https:' ? httpsAgent : httpAgent;
}

/** Close every pooled socket (called on shutdown). */
function destroyAgents() {
  try { httpAgent.destroy(); } catch { /* already gone */ }
  try { httpsAgent.destroy(); } catch { /* already gone */ }
}

module.exports = { httpAgent, httpsAgent, agentFor, destroyAgents, MAX_SOCKETS };
