require("dotenv").config();
const ImapWatcher = require("./imapWatcher");
const CardDavClient = require("./carddavClient");
const { parseAddress } = require("./utils");
// const { createDAVClient } = require("tsdav");

// TODO: group IDs at beginning, not searching each time

const imapConfig = {
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASSWORD,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT || "993", 10),
  tls: process.env.IMAP_TLS === "true" || true,
};

const explicitFolders = (process.env.IMAP_FOLDERS || "INBOX")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const SCREENER_FOLDER = (process.env.SCREENER_FOLDER || "Screener").toString();
const THE_FEED_FOLDER = (process.env.THE_FEED_FOLDER || "The Feed").toString();
const TRASH_FOLDER = (process.env.TRASH_FOLDER || "Trash").toString();
const SCREENED_OUT_GROUP_NAME =
  process.env.GROUP_SCREENED_OUT || "Screened Out";
const THE_FEED_GROUP_NAME = process.env.GROUP_THE_FEED || "The Feed";

// Ensure screener and trash are always watched so move-detection works
const folders = Array.from(
  new Set([...explicitFolders, SCREENER_FOLDER, THE_FEED_FOLDER])
);

const carddav = new CardDavClient({
  baseUrl: process.env.CARDDAV_BASE_URL,
  username: process.env.CARDDAV_USERNAME,
  password: process.env.CARDDAV_PASSWORD,
  addressBookPath: process.env.CARDDAV_ADDRESSBOOK_PATH,
});

console.log("Watching IMAP folders:", folders.join(","));
const watcher = new ImapWatcher(imapConfig, folders);

function normalizeFolder(name) {
  return (name || "").toString().trim().toLowerCase();
}

const addedFunction = async (payload) => {
  console.log("Processing queue item");
  console.log(payload);
  const { folder, mail, movedFrom } = payload || {};
  // Extract sender email and name
  const from = mail.from && mail.from[0];
  if (!from || !from.address) {
    console.log("No sender address found for message, skipping");
    return;
  }
  const parsed = parseAddress(from);
  try {
    // If message moved to Trash from Screener, add Screened Out group
    if (
      movedFrom &&
      normalizeFolder(folder) === TRASH_FOLDER.toLowerCase() &&
      normalizeFolder(movedFrom) === SCREENER_FOLDER.toLowerCase()
    ) {
      console.log(
        `Message moved from ${movedFrom} to ${folder} — marking ${parsed.address} as Screened Out`
      );
      const existing = await carddav.findContactByEmail(parsed.address);
      const contactUuid = existing
        ? existing.href.split("/").pop().replace(".vcf", "")
        : (await carddav.createContact(parsed)).uuid;

      // Find group UIDs
      const screenedOutGroupUid = await findGroupUidByName(
        SCREENED_OUT_GROUP_NAME
      );
      if (screenedOutGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "add",
        });
      }
      return;
    }

    // Update groups depending on folder
    const nf = normalizeFolder(folder);
    if (nf === "inbox") {
      const existing = await carddav.findContactByEmail(parsed.address);
      const contactUuid = existing
        ? existing.href.split("/").pop().replace(".vcf", "")
        : (await carddav.createContact(parsed)).uuid;

      const screenedOutGroupUid = await findGroupUidByName(
        SCREENED_OUT_GROUP_NAME
      );
      if (screenedOutGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "remove",
        });
      }
    } else if (nf === screenedOut.toLowerCase()) {
      const existing = await carddav.findContactByEmail(parsed.address);
      const contactUuid = existing
        ? existing.href.split("/").pop().replace(".vcf", "")
        : (await carddav.createContact(parsed)).uuid;

      const screenedOutGroupUid = await findGroupUidByName(
        SCREENED_OUT_GROUP_NAME
      );
      if (screenedOutGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "add",
        });
      }
    } else if (
      nf === (process.env.GROUP_THE_FEED || "the feed").toLowerCase()
    ) {
      const existing = await carddav.findContactByEmail(parsed.address);
      const contactUuid = existing
        ? existing.href.split("/").pop().replace(".vcf", "")
        : (await carddav.createContact(parsed)).uuid;

      const feedGroupUid = await findGroupUidByName(THE_FEED_GROUP_NAME);
      const screenedOutGroupUid = await findGroupUidByName(
        SCREENED_OUT_GROUP_NAME
      );
      if (feedGroupUid && screenedOutGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "remove",
        });
        await carddav.updateGroupMembership({
          groupUid: feedGroupUid,
          contactUuid,
          action: "add",
        });
      }
    } else {
      // other folders ignored
    }

    // Helper to find group UID by group name (FN field)
    async function findGroupUidByName(groupName) {
      await carddav._ensureClient();
      for (const ab of carddav._addressBooks || []) {
        try {
          const vcards = await carddav._client.fetchVCards({
            addressBook: ab,
          });
          for (const v of vcards) {
            if (v.data && /X-ADDRESSBOOKSERVER-KIND:group/i.test(v.data)) {
              // Match exact FN line (case-insensitive, no extra chars)
              const fnMatch = v.data.match(/^FN:(.*)$/im);
              if (
                fnMatch &&
                fnMatch[1].trim().toLowerCase() ===
                  groupName.trim().toLowerCase()
              ) {
                const uidMatch = v.data.match(/UID:([a-f0-9\-]+)/i);
                if (uidMatch) return uidMatch[1];
              }
            }
          }
        } catch (err) {
          // ignore and continue
        }
      }
      return null;
    }

    console.log("Finished this task");
    return true;
  } catch (err) {
    console.error("Error handling added message:", err);
    return false;
  }
};

const queue = require("fastq").promise(addedFunction, 1);

watcher.on("added", async (payload) => {
  console.log("Pushing to queue...");
  queue.push(payload);
});

const isSimulate =
  process.argv.includes("--simulate") || process.env.SIMULATE === "1";

if (isSimulate) {
  console.log("Running in simulate mode");
  // simulate a message added to Inbox and one to Screened Out
  (async () => {
    const sample = {
      from: [{ name: "Alice Example", address: "alice@example.com" }],
    };
    await watcher.emit("added", { folder: "INBOX", mail: sample });
    // simulate moving from Screener -> Trash
    await watcher.emit("added", {
      folder: "Trash",
      mail: sample,
      movedFrom: screener,
    });
  })();
} else {
  watcher.start();

  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    await watcher.stop();
    process.exit(0);
  });
}
