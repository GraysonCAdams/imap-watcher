require('dotenv').config();
const ImapWatcher = require('./imapWatcher');
const CardDavClient = require('./carddavClient');
const { parseAddress } = require('./utils');

const imapConfig = {
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASSWORD,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT || '993', 10),
  tls: process.env.IMAP_TLS === 'true' || true,
};

const folders = (process.env.IMAP_FOLDERS || 'INBOX,Screened Out').split(',').map(f => f.trim());

const carddav = new CardDavClient({
  baseUrl: process.env.CARDDAV_BASE_URL,
  username: process.env.CARDDAV_USERNAME,
  password: process.env.CARDDAV_PASSWORD,
  addressBookPath: process.env.CARDDAV_ADDRESSBOOK_PATH,
});

const watcher = new ImapWatcher(imapConfig, folders);

function normalizeFolder(name) {
  return (name || '').toString().trim().toLowerCase();
}

watcher.on('added', async ({ folder, mail }) => {
  // Extract sender email and name
  const from = mail.from && mail.from[0];
  if (!from || !from.address) {
    console.log('No sender address found for message, skipping');
    return;
  }
  const parsed = parseAddress(from);
  try {
    const existing = await carddav.findContactByEmail(parsed.address);
    if (!existing) {
      console.log(`Creating contact for ${parsed.address}`);
      await carddav.createContact(parsed);
    }
    // Update groups depending on folder
    const nf = normalizeFolder(folder);
    if (nf === 'inbox') {
      await carddav.updateContactGroups(parsed.address, process.env.GROUP_SCREENED || 'Screened', process.env.GROUP_SCREENED_OUT || 'Screened Out');
    } else if (nf === (process.env.GROUP_SCREENED_OUT || 'screened out').toLowerCase()) {
      await carddav.updateContactGroups(parsed.address, process.env.GROUP_SCREENED_OUT || 'Screened Out', process.env.GROUP_SCREENED || 'Screened');
    } else {
      // other folders ignored
    }
  } catch (err) {
    console.error('Error handling added message:', err);
  }
});

const isSimulate = process.argv.includes('--simulate') || process.env.SIMULATE === '1';

if (isSimulate) {
  console.log('Running in simulate mode');
  // simulate a message added to Inbox and one to Screened Out
  (async () => {
    const sample = { from: [{ name: 'Alice Example', address: 'alice@example.com' }] };
    await watcher.emit('added', { folder: 'INBOX', mail: sample });
    await watcher.emit('added', { folder: 'Screened Out', mail: sample });
  })();
} else {
  watcher.start();

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await watcher.stop();
    process.exit(0);
  });
}
