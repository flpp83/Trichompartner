const PASSWORD = "TRICHO2026";
const AUTH_KEY = "tricho_partner_auth";

function syncAuthUi() {
  const isAuthed = window.localStorage.getItem(AUTH_KEY) === "1";
  document.body.classList.toggle("is-auth", isAuthed);

  document.querySelectorAll("[data-auth-state]").forEach((node) => {
    node.textContent = isAuthed ? "Strefa partnera aktywna" : "Tryb gościa";
    node.classList.toggle("success", isAuthed);
  });

  document.querySelectorAll("[data-auth-copy]").forEach((node) => {
    node.textContent = isAuthed
      ? "Ceny i zamówienia B2B są aktywne."
      : "Wpisz hasło partnera, aby odblokować ceny i konto.";
  });

  const useMobile = window.innerWidth <= 900;
  document.querySelectorAll("[data-mockup-image]").forEach((image) => {
    const src = isAuthed
      ? (useMobile ? image.dataset.authMobile : image.dataset.authDesktop)
      : (useMobile ? image.dataset.guestMobile : image.dataset.guestDesktop);

    const fallback = isAuthed
      ? image.dataset.authDesktop || image.dataset.guestDesktop
      : image.dataset.guestDesktop || image.dataset.authDesktop;

    image.src = src || fallback || image.src;
    image.closest("[data-mockup-stage]")?.classList.toggle("mobile", useMobile);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-auth-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = form.querySelector("input");
      const status = form.querySelector("[data-auth-message]");
      const value = input.value.trim();

      if (!value) {
        localStorage.removeItem(AUTH_KEY);
        if (status) {
          status.textContent = "Wylogowano do trybu gościa.";
        }
        syncAuthUi();
        return;
      }

      if (value === PASSWORD) {
        localStorage.setItem(AUTH_KEY, "1");
        input.value = "";
        if (status) {
          status.textContent = "Hasło przyjęte. Strefa partnera odblokowana.";
        }
        syncAuthUi();
        return;
      }

      if (status) {
        status.textContent = "Nieprawidłowe hasło.";
      }
    });
  });

  document.querySelectorAll("[data-logout]").forEach((button) => {
    button.addEventListener("click", () => {
      localStorage.removeItem(AUTH_KEY);
      syncAuthUi();
    });
  });

  window.addEventListener("resize", syncAuthUi);
  syncAuthUi();
});
