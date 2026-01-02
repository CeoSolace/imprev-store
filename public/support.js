/* global io */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);

  const publicIdEl = $("#ticketPublicId");
  const roleEl = $("#ticketRole"); // "user" or "admin"
  const list = $("#chatList");
  const input = $("#chatInput");
  const sendBtn = $("#chatSend");
  const statusEl = $("#ticketStatus");

  if (!publicIdEl || !list) return;

  const publicId = String(publicIdEl.value || "").trim().toUpperCase();
  const role = String(roleEl?.value || "user");

  if (!publicId) {
    list.innerHTML = `<div class="msg msgSystem">Missing ticket ID.</div>`;
    return;
  }

  if (typeof io !== "function") {
    list.innerHTML = `<div class="msg msgSystem">Live chat unavailable.</div>`;
    return;
  }

  const socket = io({
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    socket.emit("ticket:join", { publicId, role });
  });

  socket.on("ticket:error", (msg) => {
    addMsg({ from: "system", text: msg });
    lock(true);
  });

  socket.on("ticket:status", (s) => {
    if (statusEl) statusEl.textContent = s;
    lock(s === "closed");
  });

  socket.on("ticket:message", (m) => {
    addMsg(m);
  });

  sendBtn?.addEventListener("click", send);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function send() {
    const text = String(input.value || "").trim();
    if (!text) return;
    socket.emit("ticket:send", { publicId, text });
    input.value = "";
  }

  function lock(v) {
    if (input) input.disabled = v;
    if (sendBtn) sendBtn.disabled = v;
  }

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function addMsg({ from, text, ts }) {
    const div = document.createElement("div");
    div.className = `msg msg-${from}`;
    div.innerHTML = `
      <div class="msgBody">${esc(text)}</div>
      <div class="msgTime">${new Date(ts || Date.now()).toLocaleString()}</div>
    `;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }
})();
