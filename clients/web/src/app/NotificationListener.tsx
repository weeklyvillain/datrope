import { channelRef, findUser, myRoleIds } from "@datrope/core";
import type { Message } from "@datrope/core";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { claimMessage, notificationAuthor, notificationBody, notificationTitle, shouldNotify } from "../notify/notify";
import { notifyPrefs } from "../notify/prefs";
import { client, displayName } from "../session";
import { openMessage } from "./jump";
import { shownAuthor } from "./message-author";
import { panelStore } from "./side-panel/panel";

const CLAIMED_KEY = "datrope.notified";

/** With several tabs open, the first one to claim a message shows its notification. */
function claimForThisTab(id: string): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(CLAIMED_KEY) ?? "[]") as unknown;
    const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    const next = claimMessage(list, id);
    if (!next) return false;
    localStorage.setItem(CLAIMED_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: just notify.
  }
  return true;
}

/** Shows system notifications for new messages (see notify/notify.ts for the rules). Renders nothing. */
export function NotificationListener() {
  const navigate = useNavigate();
  const location = useLocation();
  const nav = useRef(navigate);
  const path = useRef(location.pathname);
  nav.current = navigate;
  path.current = location.pathname;

  useEffect(() => client.onEvent(async (type, data) => {
    if (type !== "MESSAGE_CREATE") return;
    const m = data as Message;
    if (m.kind) return; // "X left the group" is not worth a notification
    let s = client.store.getState();
    const open = path.current.match(/^\/(?:channels|messages)\/([^/]+)/)?.[1];
    const panel = panelStore.getState().panel;
    // A thread or post panel left open from another view is not on screen: it only counts under its parent channel.
    const threadVisible = panel?.kind === "thread"
      && open === (panel.parentId ?? s.channels[panel.threadId]?.parent_channel_id);
    const postVisible = panel?.kind === "post" && open === panel.forumId;
    const openChannelIds = [
      open,
      threadVisible && panel?.kind === "thread" ? panel.threadId : undefined,
      postVisible && panel?.kind === "post" ? panel.postId : undefined,
    ].filter((x): x is string => !!x);
    const ok = shouldNotify({
      message: m,
      meId: s.me?.id,
      myRoleIds: myRoleIds(s),
      isDM: s.channels[m.channel_id]?.type === "dm",
      prefs: notifyPrefs.getState(),
      permission: "Notification" in window ? Notification.permission : "unsupported",
      hidden: document.visibilityState === "hidden" || !document.hasFocus(),
      openChannelIds,
    });
    if (!ok || !claimForThisTab(m.id)) return;
    // Threads are not in READY: fetch an unknown one so the title and the click can name its parent.
    if (!s.channels[m.channel_id]) {
      await client.getChannel(m.channel_id).catch(() => undefined);
      s = client.store.getState();
    }
    const where = channelRef(s, m.channel_id);
    const author = shownAuthor(m, m.author && findUser(s, m.author.id));
    const icon = author.avatar_url || s.server?.server.icon_url;
    try {
      const n = new Notification(notificationTitle(notificationAuthor(displayName(author), !m.author), where), {
        body: notificationBody(m.content, m.attachments?.length ?? 0),
        icon: icon ? new URL(icon, window.location.origin).href : undefined,
        tag: m.id,
      });
      n.onclick = () => {
        window.focus();
        openMessage(nav.current, where, m.id);
        n.close();
      };
    } catch {
      // Some mobile browsers only allow notifications from a service worker.
    }
  }), []);

  return null;
}
