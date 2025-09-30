const EventEmitter = require('events');
const Imap = require('imap');

class ImapWatcher extends EventEmitter {
  constructor(config, folders = ['INBOX']) {
    super();
    this.config = config;
    this.folders = folders;
    this.connections = [];
  }

  start() {
    this.folders.forEach(folder => this._openFolder(folder));
  }

  stop() {
    return Promise.all(this.connections.map(conn => new Promise((resolve) => {
      conn.end();
      resolve();
    })));
  }

  _openFolder(folder) {
    const imap = new Imap(this.config);
    imap.once('ready', () => {
      imap.openBox(folder, false, (err, box) => {
        if (err) {
          console.error(`Failed to open folder ${folder}:`, err);
          return;
        }
        console.log(`Watching folder: ${folder}`);

        // Use IDLE if supported
        imap.on('mail', (numNewMsgs) => {
          // Fetch the new messages
          const seq = `${box.messages.total - numNewMsgs + 1}:*`;
          const fetch = imap.seq.fetch(seq, { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: false });
          fetch.on('message', (msg) => {
            let mail = { from: [] };
            msg.on('body', (stream) => {
              let buffer = '';
              stream.on('data', (chunk) => buffer += chunk.toString('utf8'));
              stream.on('end', () => {
                const header = Imap.parseHeader(buffer);
                if (header.from) {
                  // header.from is array of raw strings; parse into {name, address}
                  const parsed = header.from.map(f => {
                    // crude parse: name <email>
                    const m = f.match(/^(.*) <(.+)>$/);
                    if (m) return { name: m[1].replace(/"/g, '').trim(), address: m[2].trim() };
                    return { name: '', address: f.trim() };
                  });
                  mail.from = parsed;
                }
              });
            });
            msg.once('end', () => {
              this.emit('added', { folder, mail });
            });
          });
          fetch.once('error', (err) => console.error('Fetch error:', err));
        });

        // fallback: also poll periodically
        const interval = setInterval(() => {
          imap.status(folder, (err, status) => {
            if (err) return;
            // no-op: rely on 'mail' events
          });
        }, (parseInt(process.env.POLL_INTERVAL || '30', 10)) * 1000);

        imap.once('close', () => clearInterval(interval));
      });
    });

    imap.once('error', (err) => console.error('IMAP error:', err));
    imap.once('end', () => console.log('IMAP connection ended'));
    imap.connect();
    this.connections.push(imap);
  }
}

module.exports = ImapWatcher;
