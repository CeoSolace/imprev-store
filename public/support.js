/* global io */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);

  const publicIdEl = $("#ticketPublicId");
  const roleEl = $("#ticketRole"); // user/admin
  const list = $("#chatList");
  const input = $("#chatInput");
  const sendBtn = $("#chatSend");
  const statusEl = $("#ticketStatus");

  if (!publicIdEl || !list) return;

  const publicId = String(publicIdEl.value || "").trim().toUpperCase();
  const role = String(roleEl?.value || "user").trim();

  if (!publicId) {
    list.innerHTML = `<div class="msg msgSystem"><div class="msgBody">Missing ticket ID.</div></div>`;
    return;
  }

  if (typeof io !== "function") {
    list.innerHTML = `<div class="msg msgSystem"><div class="msgBody">Live chat unavailable.</div></div>`;
    return;
  }

  const socket = io({ transports: ["websocket"] });

  socket.on("connect", () => socket.emit("ticket:join", { publicId, role }));

  socket.on("ticket:error", (msg) => {
    addMsg({ from: "system", text: String(msg || "Error"), ts: Date.now() });
    lock(true);
  });

  socket.on("ticket:status", (s) => {
    const v = String(s || "open");
    if (statusEl) statusEl.textContent = v;
    lock(v === "closed" && role !== "admin");
  });

  socket.on("ticket:history", (msgs) => {
    list.innerHTML = "";
    (Array.isArray(msgs) ? msgs : []).forEach(addMsg);
    list.scrollTop = list.scrollHeight;
  });

  socket.on("ticket:message", addMsg);

  sendBtn?.addEventListener("click", send);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $("#adminClose")?.addEventListener("click", () => socket.emit("ticket:close", { publicId }));
  $("#adminReopen")?.addEventListener("click", () => socket.emit("ticket:reopen", { publicId }));

  function send() {
    const text = String(input?.value || "").trim();
    if (!text) return;
    socket.emit("ticket:send", { publicId, text, role });
    input.value = "";
  }

  function lock(v) {
    if (input) input.disabled = !!v;
    if (sendBtn) sendBtn.disabled = !!v;
  }

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function addMsg(m) {
    const from = String(m?.from || "system");
    const text = String(m?.text || "");
    const ts = m?.ts ? Number(m.ts) : Date.now();

    const div = document.createElement("div");
    div.className = `msg msg-${from}`;
    div.innerHTML = `
      <div class="msgBody">${esc(text)}</div>
      <div class="msgTime">${new Date(ts).toLocaleString()}</div>
    `;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }
})();
