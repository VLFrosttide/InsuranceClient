"use strict";

const VisIcon = document.getElementById("VisIcon");
const Pass = document.getElementById("PassInput");
const UserName = document.getElementById("UsernameInput");
const DisplayMsg = document.getElementById("DisplayMsg");
const LoginForm = document.getElementById("LoginForm");

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

async function doLogin() {
  if (!UserName.value || !Pass.value) {
    setMessage("Enter username and password", true);
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
      setMessage(data.error || "Access Denied", true);
      return;
    }

    localStorage.setItem("token", data.token || "");
    localStorage.setItem("username", data.username || "");
    localStorage.setItem("role", data.role || "");

    window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
  } catch (error) {
    console.error("Error: ", error);
    setMessage("Server Error", true);
  }
}

LoginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doLogin();
});
