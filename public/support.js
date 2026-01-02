/* global io */
(function () {
  "use strict";

  // ---- Helpers ----
  const $ = (sel) => document.querySelector(sel);

  const publicIdEl = $("#ticketPublicId");
  const roleEl = $("#ticketRole");

  const list = $("#chatList");
  const input = $("#chatInput");
  const sendBtn = $("#chatSend");
  const statusEl = $("#ticketStatus");
  const topNoteEl = $("#chatTopNote");

  if (!publicIdEl || !list) return;

  const publicId = String(publicIdEl.value || "").trim();
  const role = String(roleEl?.value || "user").trim(); // "user" or "admin"

  if (!publicId) return;

  // Ensure socket.io is loaded
  if (typeof io !== "function") {
    list.innerHTML =
      '<div class="msg msgSystem"><div class="msgBody">Live chat failed: socket.io not loaded.</div></div>';
    return;
  }

  // ---- UI ----
  function setLocked(locked, reason) {
    if (input) input.disabled = !!locked;
    if (sendBtn) sendBtn.disabled = !!locked;

    if (locked && reason) {
      addMsg({ from: "system", text: reason, ts: Date.now() });
    }
  }

  function esc(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatTs(ts) {
    const d = ts ? new Date(ts) : new Date();
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function addMsg(m) {
    const from = m?.from || "system";
    const text = String(m?.text || "");
    const ts = m?.ts || Date.now();

    const wrap = document.createElement("div");
    wrap.className =
      "msg " +
      (from === "admin"
        ? "msgAdmin"
        : from === "user"
        ? "msgUser"
        : "msgSystem");

    const meta = document.createElement("div");
    meta.className = "msgMeta";
    meta.textContent = `${String(from).toUpperCase()} • ${formatTs(ts)}`;

    const body = document.createElement("div");
    body.className = "msgBody";
    body.innerHTML = esc(text).replaceAll("\n", "<br>");

    wrap.appendChild(meta);
    wrap.appendChild(body);
    list.appendChild(wrap);

    // autoscroll
    list.scrollTop = list.scrollHeight;
  }

  function clearMsgs() {
    list.innerHTML = "";
  }

  function setStatus(s) {
    if (statusEl) statusEl.textContent = s || "open";
  }

  function setTopNote(t) {
    if (topNoteEl) topNoteEl.textContent = t || "";
  }

  // ---- Socket ----
  const socket = io({
    transports: ["websocket", "polling"], // safe for Render/CF
    withCredentials: true,
  });

  let joined = false;

  socket.on("connect", () => {
    // join the room for this ticket
    socket.emit("ticket:join", { publicId });
  });

  socket.on("disconnect", () => {
    joined = false;
    setTopNote("Disconnected. Reconnecting…");
  });

  socket.io.on("reconnect", () => {
    setTopNote("");
    socket.emit("ticket:join", { publicId });
  });

  socket.on("ticket:authfail", (d) => {
    const msg =
      d?.message ||
      "Support access denied. Use your original ticket link to reopen.";
    setLocked(true, msg);
    setTopNote("Not authorized.");
  });

  socket.on("ticket:init", (data) => {
    joined = true;
    setTopNote("This chat updates live.");
    clearMsgs();

    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    msgs.forEach(addMsg);

    setStatus(data?.status || "open");

    // user can reply to reopen closed ticket (server handles reopen)
    setLocked(false);
  });

  socket.on("ticket:new", (m) => {
    addMsg(m);
  });

  socket.on("ticket:status", (d) => {
    setStatus(d?.status || "open");
  });

  socket.on("connect_error", () => {
    setTopNote("Connection problem. Retrying…");
  });

  // ---- Send ----
  function send() {
    if (!joined) return;

    const text = String(input?.value || "").trim();
    if (!text) return;

    // optimistic clear
    if (input) input.value = "";

    socket.emit("ticket:send", {
      publicId,
      text,
      role, // "user" or "admin"
    });
  }

  if (sendBtn) sendBtn.addEventListener("click", send);

  if (input) {
    input.addEventListener("keydown", (e) => {
      // Enter to send, Shift+Enter for newline
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }
})();
