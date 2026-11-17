const form = document.getElementById("login-form");
const errorEl = document.getElementById("error");
const submitBtn = document.getElementById("submit-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in...";

  try {
    await window.hrmsAgent.login(email, password);
    // On success the main process closes this window and switches to the
    // tray. Nothing left to do here.
  } catch (err) {
    errorEl.textContent = err.message || "Login failed";
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in";
  }
});
