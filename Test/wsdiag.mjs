const WS_URL = "wss://lavender-quail-935384.hostingersite.com/ws";

function test(name, firstMessage) {
  return new Promise((resolve) => {
    console.log(`\n=== ${name} ===`);
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => {
      console.log("(timeout 8s)");
      try { ws.close(); } catch {}
      resolve();
    }, 8000);

    ws.addEventListener("open", () => {
      console.log("open");
      if (firstMessage) ws.send(JSON.stringify(firstMessage));
    });
    ws.addEventListener("message", (e) => {
      console.log("message:", e.data);
    });
    ws.addEventListener("close", (e) => {
      console.log("close code=", e.code, "reason=", JSON.stringify(e.reason));
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", (e) => {
      console.log("error event");
    });
  });
}

// 1. connect and do nothing (server may close after auth timeout)
// 2. send auth with empty token + branch
// 3. send auth with token "x" branch "y"
// 4. send list_emails immediately without auth
await test("no-message", null);
await test("auth-empty", { type: "auth", token: "", branch: "" });
await test("auth-bogus", { type: "auth", token: "x", branch: "Lesovo" });
await test("list-without-auth", { type: "list_emails" });
