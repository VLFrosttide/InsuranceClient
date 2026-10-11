"use strict";

const VisIcon = document.getElementById("VisIcon");
const Pass = document.getElementById("PassInput");
const UserName = document.getElementById("UsernameInput");
const BranchInput = document.getElementById("BranchInput");
const DisplayMsg = document.getElementById("DisplayMsg");
const LoginForm = document.getElementById("LoginForm");
const LangButton = document.getElementById("LangButton");

function setMessage(text, isError) {
  if (!DisplayMsg) return;
  DisplayMsg.textContent = text;
  DisplayMsg.className = "msg " + (isError ? "error" : "success");
  if (!text) DisplayMsg.className = "msg";
}

if (VisIcon) {
  VisIcon.addEventListener("click", () => {
    Pass.type = Pass.type === "password" ? "text" : "password";
  });
}

function syncLangButton() {
  if (!LangButton) return;
  LangButton.textContent = getLang() === "bg" ? "EN" : "BG";
}
if (LangButton) {
  LangButton.addEventListener("click", () => {
    toggleLang();
    syncLangButton();
  });
}
syncLangButton();

async function doLogin() {
  if (!UserName.value || !Pass.value) {
    setMessage(t("enterCredentials"), true);
    return;
  }

  try {
    const LoginReq = await fetch(`${API_BASE}/logme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: UserName.value,
        password: Pass.value,
      }),
    });

    const data = await LoginReq.json().catch(() => ({}));

    if (!LoginReq.ok) {
      setMessage(data.error || t("accessDenied"), true);
      return;
    }

    localStorage.setItem("token", data.token || "");
    localStorage.setItem("username", data.username || "");
    localStorage.setItem("role", data.role || "");
    // The branch is selected at login and attached to every insurance the
    // worker creates (the add-insurance form no longer has a branch field).
    localStorage.setItem("branch", BranchInput ? BranchInput.value : "");

    // Policies queued while the session was expired (or before a restart)
    // resume with the fresh token. Only this user's own requests are updated.
    if (window.bridge && typeof window.bridge.OutboxUpdateToken === "function") {
      try {
        await window.bridge.OutboxUpdateToken(data.username || "", data.token || "");
      } catch (err) {
        console.error("Failed to hand the new token to the outbox:", err);
      }
    }

    window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
  } catch (error) {
    console.error("Error: ", error);
    setMessage(t("serverError"), true);
  }
}

LoginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doLogin();
});
