try { document.documentElement.dataset.theme = localStorage.getItem('ra_theme') || 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }
