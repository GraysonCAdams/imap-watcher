const tsdav = require("tsdav");
const { v4: uuidv4 } = require('uuid');

class CardDavClient {
  constructor({ baseUrl, username, password, addressBookPath } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, "") : "";
    this.username = username || "";
    this.password = password || "";
    this.addressBookPath = addressBookPath || "/";
    this.dryRun = !this.baseUrl; // if no baseUrl provided, operate in dry-run mode
    // enable debug via option or environment variable
    this.debug = process.env.CARDDAV_DEBUG === "1" || false;

    this._client = null;
    this._account = null;
    this._addressBooks = null;
  }

  async _ensureClient() {
    // if (this.dryRun) return;
    // if (this._client) return this._client;

    this._client = await tsdav.createDAVClient({
      serverUrl: this.baseUrl,
      authMethod: "Basic",
      credentials: {
        username: this.username,
        password: this.password,
      },
      defaultAccountType: "carddav",
    });

    // create an account and load addressbooks
    this._account = await this._client.createAccount({
      account: { accountType: "carddav" },
      loadCollections: true,
    });
    this._addressBooks = this._account.addressBooks || [];
    return this._client;
  }

  async findContactByEmail(email) {
    if (this.dryRun) {
      console.log(`[CardDAV] dry-run: findContactByEmail(${email}) => null`);
      return null;
    }
    await this._ensureClient();
    this._log("findContactByEmail", { email });
    for (const ab of this._addressBooks || []) {
      try {
        const vcards = await this._client.fetchVCards({ addressBook: ab });
        this._log("scanning vcards", {
          addressBook: ab.url,
          count: vcards.length,
        });
        for (const v of vcards) {
          const vcardText = v.data || "";
          const emailRe = new RegExp(
            `EMAIL.*:${email.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`,
            "i"
          );
          if (emailRe.test(vcardText)) {
            this._log("found vcard", { url: v.url, etag: v.etag });
            return { href: v.url, vcard: vcardText, etag: v.etag };
          }
        }
      } catch (err) {
        this._log("fetchVCards error during findContactByEmail", {
          addressBook: ab.url,
          err: err && err.stack ? err.stack : err,
        });
      }
    }
    return null;
  }

  _buildVCard({ uid, name, address }) {
    return `
BEGIN:VCARD
PRODID:-//CyrusIMAP.org//Cyrus 3.13.0-alpha0-1232-g5ef1697bd-fm-20250..//EN
VERSION:3.0
UID:${uid}
N:;;;;
FN: 
NOTE:Screener
NICKNAME:
EMAIL;TYPE=pref:${address}
TITLE:
ORG:${name};
END:VCARD
    `.trim()
  }

  async createContact({ name, address }) {
    const uid = uuidv4();
    const filename = `${uid}.vcf`
    const vcard = this._buildVCard({ uid, name, address });
    if (this.dryRun) {
      console.log(`[CardDAV] dry-run: createContact -> ${path}\n${vcard}`);
      return { href: path, vcard };
    }
    await this._ensureClient();
    const addressBooks = this._addressBooks || [];
    const ab =
      addressBooks.find(
        (c) =>
          c.url &&
          c.url
            .replace(/\/$/, "")
            .endsWith(this.addressBookPath.replace(/\/$/, ""))
      ) || addressBooks[0];
    if (!ab)
      throw new Error("No addressbook collection found for createContact");
    try {
      const res = await this._client.createVCard({
        addressBook: ab,
        filename: filename,
        vCardString: vcard
      });
      if(res.status >= 400) throw new Error(`${res.statusText} ${res.body}`)
      this._log("createVCard success", { addressBook: ab.url });
    } catch (err) {
      this._log("createVCard error", {
        addressBook: ab.url,
        err: err && err.stack ? err.stack : err,
      });
      throw err;
    }
    return {"uuid": uid};
  }

  /**
   * Update a group VCARD to add or remove a contact UUID as a MEMBER.
   * @param {Object} opts
   * @param {string} opts.groupUid - UID of the group VCARD
   * @param {string} opts.contactUuid - UUID of the contact to add/remove
   * @param {"add"|"remove"} opts.action - "add" or "remove"
   * @returns {Promise<boolean>} true if updated
   */
  async updateGroupMembership({ groupUid, contactUuid, action }) {
    if (!groupUid || !contactUuid || !["add", "remove"].includes(action)) {
      throw new Error("Missing or invalid arguments for updateGroupMembership");
    }
    if (this.dryRun) {
      console.log(
        `[CardDAV] dry-run: updateGroupMembership group=${groupUid} contact=${contactUuid} action=${action}`
      );
      return true;
    }

    await this._ensureClient();
    let groupCard = null;
    let ab = null;
    // Find the group VCARD by UID
    for (const book of this._addressBooks || []) {
      try {
        const vcards = await this._client.fetchVCards({ addressBook: book });
        for (const v of vcards) {
          if (
            v.data &&
            v.data.includes(`UID:${groupUid}`) &&
            /X-ADDRESSBOOKSERVER-KIND:group/i.test(v.data)
          ) {
            groupCard = v;
            ab = book;
            break;
          }
        }
        if (groupCard) break;
      } catch (err) {
        this._log("fetchVCards error during updateGroupMembership", {
          addressBook: book.url,
          err: err && err.stack ? err.stack : err,
        });
      }
    }
    if (!groupCard) throw new Error("Group VCARD not found");
    // Parse and update MEMBER lines, removing any broken/folded lines
    const lines = (groupCard.data.replaceAll("uuid:\r\n ", "uuid:") || "").split(/\r?\n/);
    const memberLine = `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${contactUuid}`;
    let found = false;
    let newLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Remove any folded/broken MEMBER lines (e.g., lines starting with whitespace after MEMBER:)
      if (/^X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:/i.test(line)) {
        // If this is the line for this contactUuid
        if (line.trim().toUpperCase() === memberLine.toUpperCase()) {
          found = true;
          if (action === "remove") continue; // skip to remove
        }
        // Check if next line is a continuation (starts with whitespace)
        if (lines[i + 1] && /^\s+/.test(lines[i + 1])) {
          i++; // skip the next line (continuation)
          continue;
        }
      }
      // Also skip any lines that are just a continuation of a previous MEMBER line
      if (
        /^\s+/.test(line) &&
        newLines.length &&
        /^X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:/i.test(
          newLines[newLines.length - 1]
        )
      ) {
        continue;
      }
      newLines.push(line);
    }
    if (action === "add" && !found) {
      // Insert before END:VCARD
      const endIdx = newLines.findIndex(
        (l) => l.trim().toUpperCase() === "END:VCARD"
      );
      if (endIdx === -1) newLines.push(memberLine);
      else newLines.splice(endIdx, 0, memberLine);
    }
    const newVcard = newLines.join("\r\n");
    // Update the group VCARD
    try {
      this._log("updateVCard (group membership)", {
        url: groupCard.url,
        etag: groupCard.etag,
      });
      await this._client.updateVCard({
        vCard: { url: groupCard.url, data: newVcard, etag: groupCard.etag },
      });
      this._log("updateVCard success (group membership)", {
        url: groupCard.url,
        data: newVcard,
      });
    } catch (err) {
      this._log("updateVCard error (group membership)", {
        err: err && err.stack ? err.stack : err,
      });
      throw err;
    }
    return true;
  }

  _log(...args) {
    if (!this.debug) return;
    try {
      console.debug("[CardDAV]", ...args);
    } catch (e) {
      // ignore logging errors
    }
  }
}

module.exports = CardDavClient;
