document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("submit");
  const error = document.getElementById("error");
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("password").value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось войти. Повторите попытку.");
    document.getElementById("password").value = "";
    const views = new Set(["connections", "overview", "calendar", "skills", "canvas", "tiktok", "instagram", "youtube", "telegram", "x", "uniquifier", "autodownload", "profile-download", "setup", "accounts", "account-data", "settings"]);
    const requested = window.location.hash.slice(1);
    window.location.replace("/" + (views.has(requested) ? "#" + requested : "#connections"));
  } catch (failure) { error.textContent = failure.message; }
  finally { button.disabled = false; }
});
