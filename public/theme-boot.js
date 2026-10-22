// 在样式表生效前写入主题，避免暗色启动时出现白屏闪烁。
(() => {
  const key = 'clash-manager.appearance.v1';
  const root = document.documentElement;
  const query = new URLSearchParams(location.search);
  const previewTheme = query.get('preview-theme');
  const previewFont = Number(query.get('preview-font'));
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    saved = {};
  }
  let theme = '';
  if (previewTheme === 'light' || previewTheme === 'dark') theme = previewTheme;
  else if (saved.theme === 'light' || saved.theme === 'dark') theme = saved.theme;
  else theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const font = [13, 14, 16, 18].includes(previewFont)
    ? previewFont
    : [13, 14, 16, 18].includes(saved.font)
      ? saved.font
      : 14;
  root.dataset.theme = theme;
  root.dataset.font = String(font);
})();
