// Tiny progressive enhancement: the site works without JavaScript.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => { const t = b.textContent; b.textContent = b.dataset.done || '✓'; setTimeout(() => b.textContent = t, 1600); });
});
