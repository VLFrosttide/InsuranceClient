"use strict";

let DurationOptions = ["1 ден", "15  дена", "3 месеца", "1 година"];
let BranchOptions = [
  "ГКПП Капитан Андреево",
  "ГКПП Лесово",
  "ГКПП Малко Търново",
];
let PriceOptions = [""];
let DurationInput = document.getElementById("DurationInput");
let BranchInput = document.getElementById("BranchInput");
let SubmitFormButton = document.getElementById("SubmitFormButton");
let ClearFormArray = Array.from(document.getElementsByClassName("ClearForm"));
let FormInputArray = Array.from(document.getElementsByClassName("FormInput"));
let LM = 0;
let LN = 0;
let FormObject;

DurationInput.addEventListener("wheel", (e) => {
  e.preventDefault();

  if (e.deltaY > 0) {
    LM++;
  } else {
    LM--;
  }
  LM = (LM + DurationOptions.length) % DurationOptions.length;
  DurationInput.value = DurationOptions[LM];
});
BranchInput.addEventListener("wheel", (e) => {
  e.preventDefault();

  if (e.deltaY > 0) {
    LN++;
  } else {
    LN--;
  }
  LN = (LN + BranchOptions.length) % BranchOptions.length;
  BranchInput.value = BranchOptions[LN];
});

SubmitFormButton.addEventListener("click", async function (e) {
  FormObject = {};
  for (let i = 0; i < FormInputArray.length; i++) {
    console.log(FormInputArray[i].type);
    if (FormInputArray[i].type === "checkbox") {
      FormObject[FormInputArray[i].id] = FormInputArray[i].checked;
    } else {
      FormObject[FormInputArray[i].id] = FormInputArray[i].value;
    }
  }
  console.log(FormObject);
  let DBRequest = await fetch(
    "https://insurance-server-mk84w.ondigitalocean.app",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(FormObject),
    }
  );
  for (let j = 0; j < ClearFormArray.length; j++) {
    ClearFormArray[j].value = "";
  }
});
