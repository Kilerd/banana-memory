document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const value = document.getElementById(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = '已复制';
      document.getElementById('copy-status').textContent = '命令已复制';
      setTimeout(() => { button.textContent = '复制'; }, 1800);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(button.dataset.copy));
      selection.removeAllRanges(); selection.addRange(range);
      document.getElementById('copy-status').textContent = '请按 Command+C 复制已选中的命令';
    }
  });
});
