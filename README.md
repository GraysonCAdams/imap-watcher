# IMAP Watcher → CardDAV Sync

Watches IMAP folders for new messages. When a new message is added to `INBOX` or `Screened Out` the sender is added/updated in a CardDAV address book and contact groups are adjusted:

- If message lands in `INBOX`: ensure contact exists, remove `Screened Out` group, add `Screened` group
- If message lands in `Screened Out`: ensure contact exists, remove `Screened` group, add `Screened Out` group

Setup:

1. Copy `.env.example` to `.env` and fill in values.
2. npm install
3. npm start


Notes:
- This project uses the `imap` package to watch folders. Some IMAP servers support IDLE; others require polling.
- CardDAV operations are performed via WebDAV requests using `node-fetch`.
