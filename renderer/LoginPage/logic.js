"use strict";
//Starts with: npm start

//#region Imports
//#endregion
//#region Declarations
//#endregion

let VisIcon = document.getElementById("VisIcon");
let Pass = document.getElementById("PassInput");
let UserName = document.getElementById("UsernameInput");

VisIcon.addEventListener("click", function () {
  if (PassInput.type === "password") {
    PassInput.type = "text";
  } else {
    PassInput.type = "password";
  }
});

document.addEventListener("keypress", async function (e) {
  if (e.key === "Enter") {
    console.log("Pass: ", Pass);
    console.log("Username: ", UserName);

    let LoginReq = await fetch(
      "https://insurance-server-mk84w.ondigitalocean.app",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          username: UserName.textContent,
          password: Pass.textContent,
        }),
      }
    );
    if (LoginReq.ok) {
      //Display Error msg
      console.log(LoginReq);
    } else {
      console.log("Access Denied");
      //Load Page based on user tier
    }
  }
});
