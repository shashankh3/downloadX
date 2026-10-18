'use strict';

/**
 * Token bucket rate limiter (bytes/sec). rate = 0 means unlimited.
 * Workers await take(n) per network chunk, which smooths limits across
 * all connections instead of letting one segment hog the pipe.
 */
class TokenBucket {
  constructor(ratePerSec = 0) {
    this.rate = ratePerSec;
    this.tokens = ratePerSec > 0 ? ratePerSec : Infinity;
    this.last = Date.now();
  }
  setRate(ratePerSec) {
    this.rate = ratePerSec;
    this.tokens = ratePerSec > 0 ? Math.min(this.tokens, ratePerSec) : Infinity;
    this.last = Date.now();
  }
  _refill() {
    const now = Date.now();
    if (this.rate > 0) {
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    } else {
      this.tokens = Infinity;
    }
    this.last = now;
  }
  async take(n) {
    if (n <= 0 || this.rate <= 0) return;
    for (;;) {
      this._refill();
      if (this.tokens >= n) { this.tokens -= n; return; }
      const avail = Math.floor(this.tokens);
      if (avail > 0) { this.tokens -= avail; n -= avail; }
      // never sleep longer than 500ms so limit changes apply quickly
      const waitMs = Math.max(10, Math.min(500, Math.ceil((n / this.rate) * 1000)));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

module.exports = { TokenBucket };
