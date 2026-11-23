// The Mi A2's WebView is Chrome 81 and cannot be updated: replaceChildren came with 86.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  if (typeof proto.replaceChildren !== 'function') {
    proto.replaceChildren = function replaceChildren(...nodes) {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append(...nodes);
    };
  }
}
