"use strict";
//Starts with: npm start

//#region Imports
//#endregion
//#region Declarations
//#endregion

let VisIcon = document.getElementById("VisIcon");
let Pass = document.getElementById("PassInput");
let UserName = document.getElementById("UsernameInput");
let DisplayMsg = document.getElementById("DisplayMsg");
VisIcon.addEventListener("click", function () {
  if (PassInput.type === "password") {
    PassInput.type = "text";
  } else {
    PassInput.type = "password";
  }
});

document.addEventListener("keypress", async function (e) {
  if (e.key === "Enter") {
    console.log("Pass: ", Pass.value);
    console.log("Username: ", UserName.value  );
    try {
          let LoginReq = await fetch(
            "http://127.0.0.1:5501/logme",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                username: UserName.value,
                password: Pass.value,
              }),
            }
          );

          if (LoginReq.ok) {
        window.api.LoadNewPage("C:/Users/shacx/Documents/GitHub/Insurance/renderer/AddInsurance/AddInsurance.html");
    } else {
      console.log("Access Denied");
      DisplayMsg.textContent = "Access Denied";
      DisplayMsg.style.color = "red";
      setTimeout(() => {
        DisplayMsg.textContent = "";
      }, 3000);
    }
    } 
    catch (error) {
        console.log("Error: ", error);
        DisplayMsg.textContent = "Server Error";
        DisplayMsg.style.color = "red";
        setTimeout(() => {
          DisplayMsg.textContent = "";
        }, 3000);
    }


    
  }
});
