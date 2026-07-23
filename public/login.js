document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.classList.add('hidden');

  const password = e.target.password.value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = 'index.html';
      return;
    }
    errorEl.textContent = 'Incorrect password.';
    errorEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = 'Something went wrong. Try again.';
    errorEl.classList.remove('hidden');
  }
});
