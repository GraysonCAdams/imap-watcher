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

const explicitFolders = (process.env.IMAP_FOLDERS || 'INBOX').split(',').map(f => f.trim()).filter(Boolean);
const screener = (process.env.SCREENER_FOLDER || 'Screener').toString();
const trash = (process.env.TRASH_FOLDER || 'Trash').toString();

// Ensure screener and trash are always watched so move-detection works
const folders = Array.from(new Set([...explicitFolders, screener, trash]));

const carddav = new CardDavClient({
  baseUrl: process.env.CARDDAV_BASE_URL,
  username: process.env.CARDDAV_USERNAME,
  password: process.env.CARDDAV_PASSWORD,
  addressBookPath: process.env.CARDDAV_ADDRESSBOOK_PATH,
});

console.log('Watching IMAP folders:', folders.join(','));
const watcher = new ImapWatcher(imapConfig, folders);

function normalizeFolder(name) {
  return (name || '').toString().trim().toLowerCase();
}

const SCREENER_FOLDER = (process.env.SCREENER_FOLDER || 'Screener').toString();
const TRASH_FOLDER = (process.env.TRASH_FOLDER || 'Trash').toString();

watcher.on('added', async (payload) => {
  const { folder, mail, movedFrom } = payload || {};
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
    // If message moved to Trash from Screener, add Screened Out group
    if (movedFrom && normalizeFolder(folder) === TRASH_FOLDER.toLowerCase() && normalizeFolder(movedFrom) === SCREENER_FOLDER.toLowerCase()) {
      console.log(`Message moved from ${movedFrom} to ${folder} — marking ${parsed.address} as Screened Out`);
      await carddav.updateContactGroups(parsed.address, process.env.GROUP_SCREENED_OUT || 'Screened Out', process.env.GROUP_SCREENED || 'Screened');
      return;
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
    // simulate moving from Screener -> Trash
    await watcher.emit('added', { folder: 'Trash', mail: sample, movedFrom: screener });
  })();
} else {
  watcher.start();

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await watcher.stop();
    process.exit(0);
  });
}
