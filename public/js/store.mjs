'use strict';
/*
 * Shared UI state.
 *
 * `state` mirrors the server snapshot, `ui` holds the view filters. Both are
 * plain objects so every module can read them without a framework.
 */

export const state = {
  items: [],
  settings: {},
  globalSpeed: 0,
  activeCount: 0,
  activeConnections: 0,
  connectionLimit: 0,
  shutdownArmed: false,
  shutdownIn: 0,
};

export const ui = {
  view: 'all',
  cat: 'all',
  search: '',
  sort: 'status',
  expanded: new Set(),
};

/** Rendered rows, keyed by download id (so the DOM is reused between frames). */
export const rowMap = new Map();

/** Rolling window of the global speed, used by the sparkline. */
export const speedHistory = [];

/** Last known status per download id, used to detect finished transfers. */
export const prevStatus = new Map();

export const STATUS_LABEL = {
  queued: 'Waiting', probing: 'Checking…', downloading: 'Downloading',
  paused: 'Paused', completed: 'Done', failed: 'Failed', canceled: 'Canceled',
};

export const VIEW_LABEL = {
  all: 'All downloads', downloading: 'Downloading', waiting: 'Waiting',
  completed: 'Completed', failed: 'Failed',
};