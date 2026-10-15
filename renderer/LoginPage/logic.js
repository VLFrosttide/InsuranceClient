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

// Distance beyond which a login is treated as "far from the selected branch"
// and needs an explicit confirmation before it proceeds.
const GEO_WARNING_KM = 15;

// Rough coordinates of each branch, used only to sanity-check that a login
// comes from near the branch being selected (the wrong desk, or a stray login,
// is more than a short drive away). They are approximate and never stored —
// they are only compared against the user's own rough position.
const BRANCH_COORDINATES = {
  "ГКПП Капитан Андреево": { lat: 41.720692, lng: 26.321553 },
  "ГКПП Лесово": { lat: 41.96, lng: 26.608333 },
  "Офис Харманли": { lat: 41.9325, lng: 25.9017 },
};

// Distance between two {lat, lng} points in kilometres (haversine).
function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The user's rough position from the OS location service, or null when it is
// unavailable (permission denied, no location source, or a timeout). A missing
// position is treated as "unknown", never as a reason to block the login.
function userLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

async function doLogin() {
  if (!UserName.value || !Pass.value) {
    setMessage(t("enterCredentials"), true);
    return;
  }

  // Warn when the login clearly comes from far away from the selected branch,
  // so a wrong selection (or an unexpected location) needs an explicit "yes".
  const coords = BRANCH_COORDINATES[BranchInput ? BranchInput.value : ""];
  if (coords) {
    const here = await userLocation();
    if (here) {
      const km = haversineKm(coords, here);
      if (km > GEO_WARNING_KM) {
        const msg = t("geo.warning")
          .replace("{branch}", BranchInput.value)
          .replace("{km}", String(Math.round(km)));
        if (!window.confirm(msg)) return;
      }
    }
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
      setMessage(translateError(data.error) || t("accessDenied"), true);
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
