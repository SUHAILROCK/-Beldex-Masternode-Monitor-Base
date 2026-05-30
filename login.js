'use strict';
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var pw = document.getElementById('password').value;
    var btn = document.getElementById('login-btn');
    var err = document.getElementById('login-error');
    err.style.display = 'none';
    btn.disabled = true; btn.textContent = 'Checking...';
    try {
      var r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (r.ok) {
        window.location.href = '/';
      } else {
        err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Unlock';
        document.getElementById('password').select();
      }
    } catch (ex) {
      err.textContent = 'Connection error. Try again.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  });
});
