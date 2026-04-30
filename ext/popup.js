const portEl   = document.getElementById("port");
const tokenEl  = document.getElementById("token");
const saveBtn  = document.getElementById("save");
const statusEl = document.getElementById("status");

browser.storage.local.get(["port", "token"]).then(cfg => {
  portEl.value  = cfg.port  || 18463;
  tokenEl.value = cfg.token || "";
});

saveBtn.addEventListener("click", async () => {
  const port  = parseInt(portEl.value) || 18463;
  const token = tokenEl.value.trim();

  if (!token) {
    statusEl.textContent = "Token cannot be empty.";
    statusEl.className   = "err";
    return;
  }
  if (port < 1024 || port > 65535) {
    statusEl.textContent = "Port must be between 1024 and 65535.";
    statusEl.className   = "err";
    return;
  }

  await browser.storage.local.set({ port, token });
  statusEl.textContent = "Saved.";
  statusEl.className   = "";
  setTimeout(() => { statusEl.textContent = ""; }, 2000);
});
