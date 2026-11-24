/**
 * M&A Hunter: Gmail bridge (Google Apps Script).
 *
 * Runs inside your own Google account every 5 minutes and does three things:
 *   1. Sends the outreach emails you approved in the hub, from your Gmail. Follow-ups go into the same thread.
 *   2. Reports replies from brokers and owners back to the hub, so the sequence stops and the listing moves on.
 *   3. Forwards saved-search alert emails from the marketplaces, so new listings land in the hub.
 *
 * It only ever forwards mail that is (a) in a thread the hub started, (b) from a contact you have already
 * written to, or (c) from a marketplace's alert address. Nothing else in your inbox leaves Google.
 * No OAuth app, and no password leaves your account.
 *
 * Setup (once):
 *   1. https://script.google.com → New project → paste this file.
 *   2. Project Settings → Script properties → add:
 *        HUB_URL       https://<your hub>            (no trailing slash)
 *        BRIDGE_TOKEN  the value of the Worker's GMAIL_BRIDGE_TOKEN secret
 *   3. Run `install` once and approve the permissions (read and send Gmail, connect to an external service).
 *
 * To stop it: run `uninstall`, or pause outreach in the hub (Outreach → Sender & limits).
 */

var LOOKBACK = "3d"; // how far back to look for replies and alerts
var MAX_THREADS = 60; // threads examined per run
var REMEMBER = 300; // message ids remembered as already forwarded

function install() {
  uninstall();
  ScriptApp.newTrigger("sync").timeBased().everyMinutes(5).create();
  sync();
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
}

function sync() {
  var props = PropertiesService.getScriptProperties();
  var hub = (props.getProperty("HUB_URL") || "").replace(/\/+$/, "");
  var token = props.getProperty("BRIDGE_TOKEN");
  if (!hub || !token) throw new Error("Set HUB_URL and BRIDGE_TOKEN in Script properties");
  var me = Session.getActiveUser().getEmail();

  function call(path, payload) {
    var res = UrlFetchApp.fetch(hub + path, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
      payload: JSON.stringify(payload),
    });
    if (res.getResponseCode() >= 300) throw new Error("hub " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
    return JSON.parse(res.getContentText());
  }

  // A send the hub never heard about would be sent again, so results that failed to report are retried first.
  var pending = JSON.parse(props.getProperty("PENDING_SENT") || "[]");
  if (pending.length) {
    call("/api/gmail/report", { account: me, sent: pending });
    props.deleteProperty("PENDING_SENT");
  }

  var work = call("/api/gmail/work", { account: me });

  // 1. Send what is due.
  var sent = [];
  (work.send || []).forEach(function (m) {
    try {
      var r = sendOne(m, work.fromName);
      sent.push({ id: m.id, ok: true, gmailId: r.gmailId, threadId: r.threadId });
    } catch (e) {
      sent.push({ id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
  });
  if (sent.length) props.setProperty("PENDING_SENT", JSON.stringify(sent));

  // 2 + 3. Collect replies and alerts.
  var inbound = collectInbound(work, me, props);

  if (sent.length || inbound.length) {
    var result = call("/api/gmail/report", { account: me, sent: sent, inbound: inbound });
    props.deleteProperty("PENDING_SENT");
    remember(props, inbound.map(function (m) { return m.id; }));
    console.log(JSON.stringify(result));
  }
  if (work.reason && !(work.send || []).length) console.log("Nothing sent: " + work.reason);
}

/** Send one message. A follow-up replies into its thread; a first message starts one. */
function sendOne(m, fromName) {
  var opts = fromName ? { name: fromName } : {};
  var draft = null;
  if (m.threadId) {
    var thread = GmailApp.getThreadById(m.threadId);
    if (thread) {
      var msgs = thread.getMessages();
      // Reply-all on our own last message addresses the original recipient (a plain reply would address us).
      draft = msgs[msgs.length - 1].createDraftReplyAll(m.body, opts);
      if (draft.getMessage().getTo().toLowerCase().indexOf(String(m.to).toLowerCase()) === -1) {
        draft.deleteDraft();
        draft = null;
      }
    }
  }
  if (!draft) draft = GmailApp.createDraft(m.to, m.subject, m.body, opts);
  var message = draft.send();
  return { gmailId: message.getId(), threadId: message.getThread().getId() };
}

function collectInbound(work, me, props) {
  var watchThreads = {};
  (work.watchThreads || []).forEach(function (id) { watchThreads[id] = true; });
  var watchSenders = {};
  (work.watchSenders || []).forEach(function (a) { watchSenders[String(a).toLowerCase()] = true; });
  var alertDomains = work.alertDomains || [];
  var seen = {};
  JSON.parse(props.getProperty("SEEN_IDS") || "[]").forEach(function (id) { seen[id] = true; });

  // Rotate through recent mail a page at a time so a busy inbox is still covered.
  var offset = Number(props.getProperty("PAGE_OFFSET") || 0);
  var threads = GmailApp.search("newer_than:" + LOOKBACK + " -in:chats -in:drafts", offset, MAX_THREADS);
  props.setProperty("PAGE_OFFSET", String(threads.length === MAX_THREADS && offset < 240 ? offset + MAX_THREADS : 0));

  var out = [];
  var all = GmailApp.getMessagesForThreads(threads);
  threads.forEach(function (thread, i) {
    var inWatched = !!watchThreads[thread.getId()];
    all[i].forEach(function (m) {
      var id = m.getId();
      if (seen[id]) return;
      var from = m.getFrom();
      var address = ((from.match(/<([^>]+)>/) || [])[1] || from).trim().toLowerCase();
      if (address === me.toLowerCase()) return; // our own messages
      var domain = address.split("@")[1] || "";
      var isAlert = alertDomains.some(function (d) { return domain === d || domain.slice(-d.length - 1) === "." + d; });
      if (!inWatched && !watchSenders[address] && !isAlert) return; // not ours to forward
      var item = { id: id, threadId: thread.getId(), from: from, subject: m.getSubject(), date: m.getDate().toISOString(), text: m.getPlainBody().slice(0, 12000), kind: isAlert && !inWatched ? "alert" : "reply" };
      if (item.kind === "alert") item.html = m.getBody().slice(0, 250000);
      out.push(item);
    });
  });
  return out.slice(0, 60);
}

function remember(props, ids) {
  if (!ids.length) return;
  var seen = JSON.parse(props.getProperty("SEEN_IDS") || "[]").concat(ids);
  props.setProperty("SEEN_IDS", JSON.stringify(seen.slice(-REMEMBER)));
}
