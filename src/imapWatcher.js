const EventEmitter = require("events");
const Imap = require("imap");
const dns = require("dns");
const dnsPromises = dns.promises;

class ImapWatcher extends EventEmitter {
  constructor(config, folders = ["INBOX"]) {
    super();
    this.config = config;
    this.folders = folders;
    this.connections = [];
    // recentByFolder: Map<lowerFolderName, Map<messageId, {mail, ts}>>
    this.recentByFolder = new Map();
    this.recentTTL = (parseInt(process.env.MOVE_TRACK_TTL || '86400', 10)) * 1000; // default 24h
  }

  start() {
    this.folders.forEach((folder) => this._openFolder(folder));
  }

  stop() {
    return Promise.all(
      this.connections.map(
        (conn) =>
          new Promise((resolve) => {
            conn.end();
            resolve();
          })
      )
    );
  }

  _openFolder(folder) {
    const originalHost = this.config.host;

    // Prefer using Google's DNS resolver (8.8.8.8) to resolve the IMAP host to an IP
    try {
      dns.setServers([process.env.DNS_SERVER || "8.8.8.8"]);
    } catch (e) {
      // setServers may throw in some environments; ignore and continue
    }

    dnsPromises
      .lookup(originalHost)
      .then((addr) => {
        const connConfig = Object.assign({}, this.config, {
          host: addr.address,
        });
        // Preserve SNI by setting the servername in tlsOptions when connecting to an IP
        connConfig.tlsOptions = Object.assign({}, connConfig.tlsOptions, {
          servername: originalHost,
        });
        const imap = new Imap(connConfig);
        imap.once("ready", () => {
          console.log("Ready")
          imap.openBox(folder, false, (err, box) => {
            if (err) {
              console.error(`Failed to open folder ${folder}:`, err);
              return;
            }
            console.log(`Watching folder: ${folder}`);

            // Use IDLE if supported
            imap.on("mail", (numNewMsgs) => {
              // Fetch the new messages
              const seq = `${box.messages.total - numNewMsgs + 1}:*`;
              const fetch = imap.seq.fetch(seq, {
                bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)"],
                struct: false,
              });
              fetch.on("message", (msg) => {
                let mail = { from: [] };
                msg.on("body", (stream) => {
                  let buffer = "";
                  stream.on(
                    "data",
                    (chunk) => (buffer += chunk.toString("utf8"))
                  );
                  stream.on("end", () => {
                    const header = Imap.parseHeader(buffer);
                    if (header.from) {
                      // header.from is array of raw strings; parse into {name, address}
                      const parsed = header.from.map((f) => {
                        // crude parse: name <email>
                        const m = f.match(/^(.*) <(.+)>$/);
                        if (m)
                          return {
                            name: m[1].replace(/"/g, "").trim(),
                            address: m[2].trim(),
                          };
                        return { name: "", address: f.trim() };
                      });
                      mail.from = parsed;
                      // capture Message-ID if present
                      const rawMid = header['message-id'] ? header['message-id'][0] : null;
                      if (rawMid) {
                        mail.messageId = rawMid.replace(/^<|>$/g, '').trim();
                        // remember this message for move-detection
                        try {
                          this._rememberMessage(folder, mail.messageId, mail);
                        } catch (e) {
                          // ignore
                        }
                      }
                    }
                  });
                });
                msg.once("end", () => {
                  // Detect move-from Screener -> Trash by matching messageId
                  const payload = { folder, mail };
                  try {
                    const mf = this._detectMoveFrom(folder, mail);
                    if (mf) payload.movedFrom = mf;
                  } catch (e) {
                    // ignore
                  }
                  this.emit("added", payload);
                });
              });
              fetch.once("error", (err) => console.error("Fetch error:", err));
            });

            // fallback: also poll periodically
            const interval = setInterval(() => {
              imap.status(folder, (err, status) => {
                if (err) return;
                // no-op: rely on 'mail' events
              });
            }, parseInt(process.env.POLL_INTERVAL || "30", 10) * 1000);

            imap.once("close", () => clearInterval(interval));
          });
        });

        imap.once("error", (err) => console.error("IMAP error:", err));
        imap.once("end", () => console.log("IMAP connection ended"));
        imap.connect();
        this.connections.push(imap);
      })
      .catch((err) => {
        console.error(`DNS lookup failed for ${originalHost}:`, err);
      });
  }

  _rememberMessage(folder, messageId, mail) {
    const key = (folder || '').toString().toLowerCase();
    if (!this.recentByFolder.has(key)) this.recentByFolder.set(key, new Map());
    const m = this.recentByFolder.get(key);
    m.set(messageId, { mail, ts: Date.now() });
    // schedule cleanup
    setTimeout(() => {
      const mm = this.recentByFolder.get(key);
      if (!mm) return;
      mm.delete(messageId);
    }, this.recentTTL);
  }

  _detectMoveFrom(folder, mail) {
    // If a message appears in Trash, check if we recently saw the same Message-ID
    const f = (folder || '').toString().toLowerCase();
    if (f !== TRASH_FOLDER.toLowerCase()) return null;
    const msgId = mail && mail.messageId;
    if (!msgId) return null;
    // search screener folder map
    const screenerKey = SCREENER_FOLDER.toLowerCase();
    const map = this.recentByFolder.get(screenerKey);
    if (map && map.has(msgId)) {
      return SCREENER_FOLDER;
    }
    return null;
  }
}

module.exports = ImapWatcher;
