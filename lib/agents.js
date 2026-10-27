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
  maxTotalSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  keepAliveMsecs: KEEP_ALIVE_MS,
  timeout: SOCKET_TIMEOUT_MS,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
  maxTotalSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  keepAliveMsecs: KEEP_ALIVE_MS,
  timeout: SOCKET_TIMEOUT_MS,
});

/**
 * Match the keep-alive pools to the user's global connection budget.
 *
 * The engine already hands out one slot per socket. Without this call the
 * agent would still cap every origin at 64 sockets, so raising
 * `maxConnections` above 64 had no effect. `0` means unlimited and maps to
 * `Infinity`, which is Node's own default.
 *
 * @param {number|string} limit
 * @returns {number} the effective per-origin socket limit
 */
function configureAgents(limit) {
  const n = parseInt(limit, 10);
  const max = Number.isFinite(n) && n > 0 ? n : Infinity;
  for (const agent of [httpAgent, httpsAgent]) {
    agent.maxSockets = max;
    agent.maxTotalSockets = max;
    agent.maxFreeSockets = max === Infinity ? MAX_FREE_SOCKETS : Math.min(MAX_FREE_SOCKETS, max);
  }
  return max;
}

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

module.exports = { httpAgent, httpsAgent, agentFor, configureAgents, destroyAgents, MAX_SOCKETS };
