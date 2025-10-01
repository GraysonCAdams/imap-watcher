require("dotenv").config();
const ImapWatcher = require("./imapWatcher");
const CardDavClient = require("./carddavClient");
const { parseAddress } = require("./utils");
// const { createDAVClient } = require("tsdav");

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
const screener = (process.env.SCREENER_FOLDER || "Screener").toString();
const trash = (process.env.TRASH_FOLDER || "Trash").toString();

// Ensure screener and trash are always watched so move-detection works
const folders = Array.from(new Set([...explicitFolders, screener, trash]));

const carddav = new CardDavClient({
  baseUrl: process.env.CARDDAV_BASE_URL,
  username: process.env.CARDDAV_USERNAME,
  password: process.env.CARDDAV_PASSWORD,
  addressBookPath: process.env.CARDDAV_ADDRESSBOOK_PATH,
});

carddav.listContacts();

console.log("Watching IMAP folders:", folders.join(","));
const watcher = new ImapWatcher(imapConfig, folders);

function normalizeFolder(name) {
  return (name || "").toString().trim().toLowerCase();
}

const SCREENER_FOLDER = (process.env.SCREENER_FOLDER || "Screener").toString();
const TRASH_FOLDER = (process.env.TRASH_FOLDER || "Trash").toString();

watcher.on("added", async (payload) => {
  const { folder, mail, movedFrom } = payload || {};
  // Extract sender email and name
  const from = mail.from && mail.from[0];
  if (!from || !from.address) {
    console.log("No sender address found for message, skipping");
    return;
  }
  const parsed = parseAddress(from);
  try {
    const existing = await carddav.findContactByEmail(parsed.address);
    let contactUuid = existing
      ? existing.href.split("/").pop().replace(".vcf", "")
      : null;
    if (!existing) {
      console.log(`Creating contact for ${parsed.address}`);
      const newContact = await carddav.createContact(parsed);
      contactUuid = newContact.href.split("/").pop().replace(".vcf", "");
    }
    // If message moved to Trash from Screener, add Screened Out group
    if (
      movedFrom &&
      normalizeFolder(folder) === TRASH_FOLDER.toLowerCase() &&
      normalizeFolder(movedFrom) === SCREENER_FOLDER.toLowerCase()
    ) {
      console.log(
        `Message moved from ${movedFrom} to ${folder} — marking ${parsed.address} as Screened Out`
      );
      // Find group UIDs
      const screenedGroupName = process.env.GROUP_SCREENED || "Screened";
      const screenedOutGroupName =
        process.env.GROUP_SCREENED_OUT || "Screened Out";
      const screenedGroupUid = await findGroupUidByName(screenedGroupName);
      const screenedOutGroupUid = await findGroupUidByName(
        screenedOutGroupName
      );
      if (screenedOutGroupUid && screenedGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "add",
        });
        await carddav.updateGroupMembership({
          groupUid: screenedGroupUid,
          contactUuid,
          action: "remove",
        });
      }
      return;
    }

    // Update groups depending on folder
    const nf = normalizeFolder(folder);
    if (nf === "inbox") {
      const screenedGroupName = process.env.GROUP_SCREENED || "Screened";
      const screenedOutGroupName =
        process.env.GROUP_SCREENED_OUT || "Screened Out";
      const screenedGroupUid = await findGroupUidByName(screenedGroupName);
      const screenedOutGroupUid = await findGroupUidByName(
        screenedOutGroupName
      );
      console.log(screenedGroupUid, screenedOutGroupUid);
      if (screenedGroupUid && screenedOutGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedGroupUid,
          contactUuid,
          action: "add",
        });
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "remove",
        });
      }
    } else if (
      nf === (process.env.GROUP_SCREENED_OUT || "screened out").toLowerCase()
    ) {
      const contactUuid = require("crypto")
        .createHash("sha1")
        .update(parsed.address)
        .digest("hex");
      const screenedGroupName = process.env.GROUP_SCREENED || "Screened";
      const screenedOutGroupName =
        process.env.GROUP_SCREENED_OUT || "Screened Out";
      const screenedGroupUid = await findGroupUidByName(screenedGroupName);
      const screenedOutGroupUid = await findGroupUidByName(
        screenedOutGroupName
      );
      console.log(screenedGroupUid, screenedOutGroupUid);
      if (screenedGroupUid && screenedOutGroupUid) {
        await carddav.updateGroupMembership({
          groupUid: screenedOutGroupUid,
          contactUuid,
          action: "add",
        });
        await carddav.updateGroupMembership({
          groupUid: screenedGroupUid,
          contactUuid,
          action: "remove",
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
          const vcards = await carddav._client.fetchVCards({ addressBook: ab });
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
  } catch (err) {
    console.error("Error handling added message:", err);
  }
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
