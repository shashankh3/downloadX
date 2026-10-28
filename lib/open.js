'use strict';
/*
 * Open a file or a folder with the operating system.
 * Used by the API to show a finished download or its folder.
 */
const path = require('path');
const { spawn } = require('child_process');

/**
 * @param {string} target the file or folder to open
 * @param {boolean} [select] open the folder with the file selected
 */
function openPath(target, select) {
  if (process.env.DLX_NO_OPEN === '1') return;
  const child = (() => {
    if (process.platform === 'win32') {
      return select
        ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' })
        : spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
    }
    if (process.platform === 'darwin') {
      return select
        ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
        : spawn('open', [target], { detached: true, stdio: 'ignore' });
    }
    return spawn('xdg-open', [select ? path.dirname(target) : target], { detached: true, stdio: 'ignore' });
  })();
  child.on('error', () => { /* opener unavailable */ });
  child.unref();
}

module.exports = { openPath };
