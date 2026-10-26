'use strict';
/*
 * Translations for the web UI.
 *
 * The English text is the key, so a missing translation simply falls back to
 * the original string - a half translated interface never breaks. Adding a
 * language means adding one dictionary and one entry to LANGS.
 *
 * The choice is stored in the browser (localStorage), not on the server: the
 * app is local and a language is a personal preference.
 */

export const LANGS = {
  en: 'English',
  de: 'Deutsch',
};

export const DICT = {
  en: {},
  de: {
    // sidebar
    'downloadX': 'downloadX',
    'Skip to downloads': 'Zu den Downloads springen',
    '/s': '/s',
    'Reliability': 'Zuverlässigkeit',
    'Downloads': 'Downloads',
    'All': 'Alle',
    'Downloading': 'Lädt herunter',
    'Waiting': 'Wartet',
    'Completed': 'Fertig',
    'Failed': 'Fehlgeschlagen',
    'Categories': 'Kategorien',
    'All categories': 'Alle Kategorien',
    'Programs': 'Programme',
    'Compressed': 'Archive',
    'Video': 'Video',
    'Music': 'Musik',
    'Documents': 'Dokumente',
    'Images': 'Bilder',
    'Others': 'Sonstiges',
    'Settings': 'Einstellungen',
    'Dark mode': 'Dunkles Design',
    'Light mode': 'Helles Design',
    'Download Manager': 'Download-Manager',
    // toolbar
    'All downloads': 'Alle Downloads',
    'Pause all': 'Alle anhalten',
    'Resume all': 'Alle fortsetzen',
    'Retry failed': 'Fehlgeschlagene wiederholen',
    'Clear': 'Aufräumen',
    'New download': 'Neuer Download',
    'Status': 'Status',
    'Date added': 'Hinzugefügt am',
    'Name': 'Name',
    'Size': 'Größe',
    'Speed': 'Geschwindigkeit',
    // status bar
    'Engine ready': 'Bereit',
    '1 item': '1 Eintrag',
    '{n} items': '{n} Einträge',
    '{active} active · {waiting} waiting': '{active} aktiv · {waiting} in Warteschlange',
    '1 connection': '1 Verbindung',
    '{n} connections': '{n} Verbindungen',
    '{n} completed': '{n} abgeschlossen',
    'Transferring — {n} connections': 'Überträgt — {n} Verbindungen',
    // empty state
    'Nothing here yet': 'Noch nichts vorhanden',
    'Drop links to download': 'Links zum Herunterladen ablegen',
    // shutdown banner
    'All downloads finished —': 'Alle Downloads sind fertig —',
    'system shutdown in': 'Rechner wird heruntergefahren in',
    'Cancel shutdown': 'Herunterfahren abbrechen',
    // update banner
    'is available.': 'ist verfügbar.',
    'Get update': 'Update holen',
    'Dismiss': 'Ausblenden',
    // add dialog
    'Paste URLs, batch patterns or mirror lists': 'URLs, Stapelmuster oder Spiegel-Listen einfügen',
    'URL(s) — one per line, patterns supported': 'URL(s) — eine pro Zeile, Muster werden unterstützt',
    'Filename (optional, single URL)': 'Dateiname (optional, einzelne URL)',
    'Category': 'Kategorie',
    'Auto-detect': 'Automatisch erkennen',
    'Connections': 'Verbindungen',
    'Speed limit (KB/s, 0 = none)': 'Geschwindigkeitslimit (KB/s, 0 = keines)',
    'Advanced': 'Erweitert',
    'Mirror URLs (one per line — used automatically if the primary fails)': 'Spiegel-URLs (eine pro Zeile — werden automatisch benutzt, wenn die primäre ausfällt)',
    'Referer (some sites require it)': 'Referer (manche Seiten verlangen ihn)',
    'Cookies (e.g.': 'Cookies (z. B.',
    'HTTP username (optional)': 'HTTP-Benutzername (optional)',
    'HTTP password (optional)': 'HTTP-Passwort (optional)',
    'Proxy (optional —': 'Proxy (optional —',
    'Custom headers (one per line,': 'Eigene Header (einer pro Zeile,',
    'Expected checksum (optional — verified when the download finishes)': 'Erwartete Prüfsumme (optional — wird nach dem Download geprüft)',
    'Save to custom folder (optional)': 'In eigenen Ordner speichern (optional)',
    'Add paused (download later)': 'Pausiert hinzufügen (später starten)',
    'Cancel': 'Abbrechen',
    'Add': 'Hinzufügen',
    'Grab links from a page': 'Links von einer Seite sammeln',
    // settings dialog
    'Engine, folders, schedule and power': 'Motor, Ordner, Zeitplan und Energie',
    'Download folder': 'Download-Ordner',
    'Max simultaneous downloads': 'Maximale parallele Downloads',
    'Max connections (0 = unlimited)': 'Maximale Verbindungen (0 = unbegrenzt)',
    'Default connections per file': 'Standard-Verbindungen pro Datei',
    'Global speed limit (KB/s, 0 = none)': 'Globales Geschwindigkeitslimit (KB/s, 0 = keines)',
    'Global proxy (optional — used when a download has none)': 'Globaler Proxy (optional — wird benutzt, wenn ein Download keinen hat)',
    'Sort files into category folders': 'Dateien in Kategorieordner sortieren',
    'Allow invalid TLS certificates (not recommended)': 'Ungültige TLS-Zertifikate erlauben (nicht empfohlen)',
    'Update manifest URL (optional — HTTPS JSON with': 'Update-Manifest-URL (optional — HTTPS-JSON mit',
    'Webhook URL (optional — called when a download finishes or fails)': 'Webhook-URL (optional — wird aufgerufen, wenn ein Download endet oder fehlschlägt)',
    'Free space on the download volume: —': 'Freier Speicher auf dem Download-Laufwerk: —',
    'Free space on the download volume: {size}': 'Freier Speicher auf dem Download-Laufwerk: {size}',
    'Free space on the download volume: unknown': 'Freier Speicher auf dem Download-Laufwerk: unbekannt',
    'Refresh': 'Aktualisieren',
    'Schedule — download only inside this window': 'Zeitplan — nur in diesem Zeitfenster herunterladen',
    'Enable schedule': 'Zeitplan aktivieren',
    'From (HH:MM)': 'Von (HH:MM)',
    'To (HH:MM)': 'Bis (HH:MM)',
    'Retries per download before it is marked as failed': 'Wiederholungen pro Download, bevor er als fehlgeschlagen gilt',
    'Scan finished downloads with Microsoft Defender': 'Fertige Downloads mit Microsoft Defender prüfen',
    'Mark downloads as coming from the internet (Windows SmartScreen)': 'Downloads als aus dem Internet kommend markieren (Windows SmartScreen)',
    'Notifications': 'Benachrichtigungen',
    'Notify when downloads finish': 'Benachrichtigen, wenn Downloads fertig sind',
    'Play a sound when downloads finish': 'Ton abspielen, wenn Downloads fertig sind',
    'Browser integration': 'Browser-Integration',
    'Send links and browser downloads straight to downloadX. The Windows installer sets this up automatically.': 'Links und Browser-Downloads direkt an downloadX senden. Der Windows-Installer richtet das automatisch ein.',
    'Install browser extension': 'Browser-Erweiterung installieren',
    'Shut down computer when all downloads finish': 'Rechner herunterfahren, wenn alle Downloads fertig sind',
    'Save': 'Speichern',
    'Language': 'Sprache',
    'Interface language': 'Sprache der Oberfläche',
    'Reconnecting…': 'Verbindung wird wiederhergestellt …',
    // compact UI and new download features
    'Active': 'Aktiv',
    'Done': 'Fertig',
    'URL(s)': 'URL(s)',
    'Filename': 'Dateiname',
    'Speed limit': 'Geschwindigkeitslimit',
    'Priority': 'Priorität',
    'Wait for': 'Warten auf',
    'Window start': 'Fensterbeginn',
    'Window end': 'Fensterende',
    'Days': 'Tage',
    'Referer': 'Referer',
    'Cookies': 'Cookies',
    'Username': 'Benutzername',
    'Password': 'Passwort',
    'Proxy': 'Proxy',
    'Headers': 'Header',
    'Checksum': 'Prüfsumme',
    'Folder': 'Ordner',
    'Grab links': 'Links sammeln',
    'Page URL': 'Seiten-URL',
    'Depth': 'Tiefe',
    'File types': 'Dateitypen',
    'Grab': 'Sammeln',
    'Use links': 'Links verwenden',
    'Simultaneous': 'Gleichzeitig',
    'Max connections': 'Max. Verbindungen',
    'Default connections': 'Standard-Verbindungen',
    'Hourly quota': 'Stundenkontingent',
    'Update manifest': 'Update-Manifest',
    'Webhook': 'Webhook',
    'Schedule': 'Zeitplan',
    'From': 'Von',
    'To': 'Bis',
    'Retries': 'Wiederholungen',
    'Library': 'Bibliothek',
    'Waiting for': 'Wartet auf',
    'Queue': 'Warteschlange',
    'Address': 'Adresse',
    // shortcuts dialog
    'Keyboard shortcuts': 'Tastenkürzel',
    'Everything you can do without the mouse': 'Alles, was ohne Maus möglich ist',
    'Close': 'Schließen',
    // confirm dialog
    'Are you sure?': 'Sind Sie sicher?',
    'Delete': 'Löschen',
    // detail panel
    'URL': 'URL',
    'Mirrors': 'Spiegel',
    'URL copied': 'URL kopiert',
    'Pause': 'Anhalten',
    'Resume': 'Fortsetzen',
    'Retry': 'Wiederholen',
    'Stop & remove': 'Anhalten & entfernen',
    'Stop download?': 'Download anhalten?',
    'Remove': 'Entfernen',
    'Remove download?': 'Download entfernen?',
    'Remove from list': 'Aus der Liste entfernen',
    'Open folder': 'Ordner öffnen',
    'Open file': 'Datei öffnen',
    'Download again': 'Erneut herunterladen',
    'Download again?': 'Erneut herunterladen?',
    'Delete file': 'Datei löschen',
    'Delete file?': 'Datei löschen?',
    'Deleted': 'Gelöscht',
    'Copy URL': 'URL kopieren',
    'Saved to': 'Gespeichert unter',
    'Resumable': 'Fortsetzbar',
    'Expected hash': 'Erwartete Prüfsumme',
    'Error': 'Fehler',
    'Integrity': 'Integrität',
    'Limit': 'Limit',
    'Result': 'Ergebnis',
    'Added': 'Hinzugefügt',
    'Completed': 'Fertig',
    'Quality': 'Qualität',
    'Change': 'Ändern',
    'Audio track': 'Tonspur',
    'Media stream': 'Medien-Stream',
    'Download URL': 'Download-URL',
  },
};

const KEY = 'dlx-lang';
let current = 'en';

/** The language code that is used right now. */
export function language() {
  return current;
}

/** The available languages. */
export function languages() {
  return Object.entries(LANGS).map(([code, name]) => ({ code, name }));
}

/**
 * Translate a piece of text. Unknown texts are returned unchanged.
 * Placeholders like {n} are filled from `vars`.
 * @param {string} text
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
export function t(text, vars) {
  let out = text;
  if (text && current !== 'en') {
    const table = DICT[current];
    out = (table && table[text]) || text;
  }
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.split('{' + key + '}').join(String(value));
    }
  }
  return out;
}

/**
 * Switch the language and translate the page.
 * @param {string} code
 * @returns {string} the language that is now active
 */
export function setLanguage(code) {
  current = LANGS[code] ? code : 'en';
  try { localStorage.setItem(KEY, current); } catch { /* private mode */ }
  applyTranslations();
  return current;
}

/**
 * Translate every element that carries a data-i18n attribute.
 * @param {ParentNode} [root]
 */
export function applyTranslations(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    const text = t(key);
    if (text !== key) node.textContent = text;
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = node.getAttribute('data-i18n-placeholder');
    const text = t(key);
    if (text !== key) node.setAttribute('placeholder', text);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    const key = node.getAttribute('data-i18n-title');
    const text = t(key);
    if (text !== key) node.setAttribute('title', text);
  }
}

/** Read the saved language and apply it. */
export function initLanguage() {
  let stored = '';
  try { stored = localStorage.getItem(KEY) || ''; } catch { /* private mode */ }
  current = LANGS[stored] ? stored : 'en';
  applyTranslations();
  return current;
}
