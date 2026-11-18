(() => {
  const bar = document.getElementById('database-find');
  const input = document.getElementById('database-find-input');
  const status = document.getElementById('database-find-status');
  let matches = [];
  let current = -1;

  function open () { bar.hidden = false; if (input.value) search(); input.focus(); input.select(); }
  function paint () {
    CSS.highlights.delete('qbss-find');
    CSS.highlights.delete('qbss-find-current');
    if (matches.length) CSS.highlights.set('qbss-find', new Highlight(...matches));
    if (current >= 0 && matches[current]) CSS.highlights.set('qbss-find-current', new Highlight(matches[current]));
    status.textContent = input.value ? (matches.length ? `${current >= 0 ? current + 1 : 0} of ${matches.length}` : 'No matches found.') : '';
  }
  function search () {
    matches = [];
    current = -1;
    const query = input.value.toLocaleLowerCase();
    if (query) {
      const walker = document.createTreeWalker(document.getElementById('root'), NodeFilter.SHOW_TEXT, {
        acceptNode (node) {
          const parent = node.parentElement;
          return parent && !parent.closest('script, style, input, textarea, select, [hidden], .collapse:not(.show)') && parent.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.data.toLocaleLowerCase();
        let index = 0;
        while ((index = text.indexOf(query, index)) !== -1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + query.length);
          matches.push(range);
          index += query.length;
        }
      }
    }
    paint();
  }
  function navigate (backwards = false) {
    if (!matches.length) return;
    current = current < 0 ? (backwards ? matches.length - 1 : 0) : (current + (backwards ? -1 : 1) + matches.length) % matches.length;
    paint();
    matches[current].startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input.focus({ preventScroll: true });
  }
  function close () { bar.hidden = true; CSS.highlights.delete('qbss-find'); CSS.highlights.delete('qbss-find-current'); input.blur(); }
  input.addEventListener('input', search);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey); }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  document.getElementById('database-find-next').addEventListener('click', () => navigate());
  document.getElementById('database-find-previous').addEventListener('click', () => navigate(true));
  document.getElementById('database-find-close').addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); open(); }
  });
  window.addEventListener('message', event => {
    if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === 'qbss-find') open();
  });
})();
