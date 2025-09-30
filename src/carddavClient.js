const fetch = require('node-fetch');
const crypto = require('crypto');

class CardDavClient {
  constructor({ baseUrl, username, password, addressBookPath } = {}) {
    // Be tolerant when environment variables aren't provided so the module
    // can be loaded in development/test without immediately throwing.
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : '';
    this.username = username || '';
    this.password = password || '';
    this.addressBookPath = addressBookPath || '/';
    this.dryRun = !this.baseUrl; // if no baseUrl provided, operate in dry-run mode
  }

  async _request(path, options = {}) {
    if (!path.startsWith('http') && !this.baseUrl) {
      throw new Error('CardDAV baseUrl is not configured. Set CARDDAV_BASE_URL in environment.');
    }
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = options.headers || {};
    headers['Authorization'] = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    if (!headers['Content-Type'] && options.body) headers['Content-Type'] = 'text/vcard; charset=utf-8';
    const res = await fetch(url, { ...options, headers });
    if (!res.ok && res.status !== 207) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`CardDAV request failed ${res.status} ${res.statusText}: ${body}`);
    }
    return res;
  }

  async listContacts() {
    if (this.dryRun) {
      console.log('[CardDAV] dry-run: listContacts skipped');
      return [];
    }
    // PROPFIND to the addressbook path
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<d:propfind xmlns:d=\"DAV:\">\n  <d:prop>\n    <d:getetag/>\n  </d:prop>\n</d:propfind>`;
    const res = await this._request(this.addressBookPath, { method: 'PROPFIND', body, headers: { 'Depth': '1' } });
    const text = await res.text();
    // parse hrefs
    const hrefs = [];
    const hrefRe = /<d:href>(.*?)<\/d:href>/gi;
    let m;
    while ((m = hrefRe.exec(text))) {
      hrefs.push(m[1]);
    }
    return hrefs;
  }

  async findContactByEmail(email) {
    if (this.dryRun) {
      console.log(`[CardDAV] dry-run: findContactByEmail(${email}) => null`);
      return null;
    }
    // Get list of hrefs under the addressbook
    const hrefs = await this.listContacts();
    for (const href of hrefs) {
      // ignore collection root
      try {
        const res = await this._request(href, { method: 'GET' });
        const vcard = await res.text();
        const emailRe = new RegExp(`EMAIL.*:${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        if (emailRe.test(vcard)) {
          return { href, vcard };
        }
      } catch (err) {
        // ignore errors fetching individual items
      }
    }
    return null;
  }

  _contactPath(uid) {
    const base = this.addressBookPath.replace(/\/$/, '') + '/';
    return base + uid + '.vcf';
  }

  _buildVCard({ name, address, groups = [] }) {
    const lines = [];
    lines.push('BEGIN:VCARD');
    lines.push('VERSION:3.0');
    if (name) lines.push(`FN:${name}`);
    lines.push(`EMAIL;TYPE=INTERNET:${address}`);
    if (groups && groups.length) lines.push(`CATEGORIES:${groups.join(',')}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }

  async createContact({ name, address }) {
    const uid = crypto.createHash('sha1').update(address).digest('hex');
    const path = this._contactPath(uid);
    const vcard = this._buildVCard({ name, address, groups: [] });
    if (this.dryRun) {
      console.log(`[CardDAV] dry-run: createContact -> ${path}\n${vcard}`);
      return { href: path, vcard };
    }
    await this._request(path, { method: 'PUT', body: vcard });
    return { href: path, vcard };
  }

  async updateContactGroups(email, addGroup, removeGroup) {
    const found = await this.findContactByEmail(email);
    let groups = [];
    let name = '';
    if (found && found.vcard) {
      // parse vcard categories
      const vc = found.vcard || '';
      const m = vc.match(/CATEGORIES:(.*)/i);
      if (m) groups = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const fn = vc.match(/FN:(.*)/i);
      if (fn) name = fn[1].trim();
    }
    // remove removeGroup
    groups = groups.filter(g => g.toLowerCase() !== (removeGroup || '').toLowerCase());
    // add addGroup if not present
    if (addGroup && !groups.map(g => g.toLowerCase()).includes(addGroup.toLowerCase())) {
      groups.push(addGroup);
    }
    const vcard = this._buildVCard({ name, address: email, groups });
    const uid = crypto.createHash('sha1').update(email).digest('hex');
    const path = this._contactPath(uid);
    if (this.dryRun) {
      console.log(`[CardDAV] dry-run: updateContactGroups -> ${path}\n${vcard}`);
      return true;
    }
    await this._request(path, { method: 'PUT', body: vcard });
    return true;
  }
}

module.exports = CardDavClient;
